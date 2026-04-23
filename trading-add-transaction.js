// ============================================================================
// trading-add-transaction.js — Add Transaction Modal for Trading Module

// Script-reload reset: this module is lazy-loaded by trading.js and the script
// tag is re-executed whenever the Trading tab is re-entered after a module
// switch-away. The `_atModuleInitDone` flag on window survives those reloads,
// which made initAddTxnModule() bail early on the second load — leaving
// `atInvBrkDdCtrl` null and the investor/broker dropdown non-functional until
// a full page refresh. Resetting the flag here ensures initAddTxnModule() runs
// against the freshly-injected DOM every time the script re-executes.
// See WMS-LESSONS §A.1.2a (lazy-loaded-module init guards).
window._atModuleInitDone = false;

// Rule A.1.2: All module-level state uses var (not let/const) to avoid TDZ on reload
// Rule A.1.3: No function names that collide with utils.js const (showAlert, showLoading)
// ============================================================================

// SUPABASE_URL and SUPABASE_ANON_KEY are globals from app.html — do not redeclare

// Reference data — aliases to wmsRefData (loaded once at app startup in wms-shared.js)
// Local aliases for backward compatibility with dropdown/autocomplete code
var atInvestors = [];         // Synced from wmsRefData.investors
var atBrokers = [];           // Synced from wmsRefData.brokers
var atInvObjMap = {};         // Synced from wmsRefData.investorObjMap
var atBrkObjMap = {};         // Synced from wmsRefData.brokerObjMap
var atExistingTags = [];      // Synced from wmsRefData.tags

// Form state
var atSelectedInvestor = null;  // {id, name, short_name}
var atSelectedBroker = null;    // {id, name, broker_code}
var atRows = [];                // Array of row data objects
var atNextRowId = 1;

// Combined investor-broker pairs (built from ibaRatesMap)
var atInvBrkPairs = [];         // [{investor, broker, label, searchStr}]
var atInvBrkDdCtrl = null;
var atInvBrkDdItems = [];

// Dropdown controllers (wmsDropdown)
var atSymDdCtrls = {};        // rowId → wmsDropdown controller

// Tag input controllers (wmsTagInput)
var atTagInputCtrls = {};     // rowId → wmsTagInput controller

// Dropdown data (for wmsDropdown onSelect callback)
var atSymDdItems = {};        // rowId → symbol results array

// Options constants now in wms-shared.js (WMS_MONTHS_SHORT, WMS_WEEKLY_EXPIRY_UNDERLYINGS)

// Charges popover state
var atCpRowId = null;

// Last saved date — persists between modal opens so user can keep entering same-day trades
var atLastSavedDate = null;  // Date object or null (first open uses today)

// ============================================================================
// Module Init
// ============================================================================

function initAddTxnModule() {
    if (window._atModuleInitDone) return;

    // Modal close handlers
    document.getElementById('addTxnCloseBtn').addEventListener('click', closeAddTxnModal);
    document.getElementById('addTxnCancelBtn').addEventListener('click', closeAddTxnModal);
    document.getElementById('addTxnOverlay').addEventListener('click', function(e) {
        if (e.target === this) closeAddTxnModal();
    });

    // Save
    document.getElementById('addTxnSaveBtn').addEventListener('click', openAddTxnConfirmation);

    // Charges popover close
    document.getElementById('addTxnCpCloseBtn').addEventListener('click', closeAddTxnCp);
    document.getElementById('addTxnCpOverlay').addEventListener('click', function(e) {
        if (e.target === this) closeAddTxnCp();
    });

    // Confirmation dialog
    document.getElementById('addTxnConfirmCancelBtn').addEventListener('click', closeAddTxnConfirm);
    document.getElementById('addTxnConfirmOkBtn').addEventListener('click', importAddTxnToDb);

    // Combined investor > broker search
    setupAddTxnInvBrkSearch();

    // ESC key handler
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (document.getElementById('addTxnConfirmOverlay').classList.contains('show')) {
                closeAddTxnConfirm();
            } else if (document.getElementById('addTxnCpOverlay').classList.contains('show')) {
                closeAddTxnCp();
            } else if (document.getElementById('addTxnOverlay').classList.contains('show')) {
                closeAddTxnModal();
            }
        }
    });

    window._atModuleInitDone = true;
}

// ============================================================================
// Open / Close Modal
// ============================================================================

async function openAddTxnModal() {
    // Ensure shared ref data is loaded (loaded once at app startup)
    if (!wmsRefData.ready) {
        await wmsLoadRefData();
    }
    // Sync local aliases from shared ref data
    atInvestors = wmsRefData.investors;
    atBrokers = wmsRefData.brokers;
    atInvObjMap = wmsRefData.investorObjMap;
    atBrkObjMap = wmsRefData.brokerObjMap;
    atExistingTags = wmsRefData.tags;

    // Build combined investor-broker pairs from ibaRatesMap
    atInvBrkPairs = [];
    var ibaKeys = Object.keys(wmsRefData.ibaRatesMap);
    ibaKeys.forEach(function(key) {
        var parts = key.split('|');
        var inv = wmsRefData.investorObjMap[parts[0]];
        var brk = wmsRefData.brokerObjMap[parts[1]];
        if (inv && brk) {
            var invLabel = inv.short_name || inv.name;
            var brkLabel = brk.broker_code || brk.name;
            var label = invLabel + ' > ' + brkLabel;
            atInvBrkPairs.push({
                investor: inv,
                broker: brk,
                label: label,
                searchStr: (invLabel + ' ' + (inv.name || '') + ' ' + brkLabel + ' ' + (brk.name || '')).toLowerCase()
            });
        }
    });
    // Sort by investor name, then broker
    atInvBrkPairs.sort(function(a, b) {
        return a.label.toLowerCase() < b.label.toLowerCase() ? -1 : (a.label.toLowerCase() > b.label.toLowerCase() ? 1 : 0);
    });

    // Reset state
    atSelectedInvestor = null;
    atSelectedBroker = null;
    atRows = [];
    atNextRowId = 1;
    document.getElementById('addTxnTbody').innerHTML = '';
    document.getElementById('addTxnInvBrkInput').value = '';
    document.getElementById('addTxnInvBrkBadge').innerHTML = '';
    document.getElementById('addTxnInvBrkInput').disabled = false;
    document.getElementById('addTxnSaveBtn').disabled = false;

    // Default date: last saved date if available, otherwise today
    atDateSetFromDate(atLastSavedDate || new Date());

    // Add first empty row
    addAddTxnRow();

    // Show modal
    document.getElementById('addTxnOverlay').classList.add('show');

    // Focus date field (user typically enters date first)
    setTimeout(function() {
        var dateWrap = document.getElementById('addTxnDateWrap');
        if (dateWrap) dateWrap.focus();
    }, 100);
}

function closeAddTxnModal() {
    document.getElementById('addTxnOverlay').classList.remove('show');
}

window.openAddTxnModal = openAddTxnModal;
window.closeAddTxnModal = closeAddTxnModal;

// Reference data loading removed — now uses wmsRefData from wms-shared.js (loaded at app startup)

// ============================================================================
// Investor / Broker Type-to-Search
// ============================================================================

function setupAddTxnInvBrkSearch() {
    var input = document.getElementById('addTxnInvBrkInput');
    var dd = document.getElementById('addTxnInvBrkDd');

    atInvBrkDdCtrl = wmsDropdown(input, dd, {
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            if (idx >= 0 && idx < atInvBrkDdItems.length) {
                selectAddTxnInvBrk(atInvBrkDdItems[idx]);
            }
        },
        itemSelector: '.wms-dd-item',
        closeOnSelect: true,
        blurDelay: 200,
        escClearsInput: true
    });

    input.addEventListener('input', function() {
        var q = input.value.trim().toLowerCase();
        if (q.length === 0) {
            // Show all pairs when empty (on focus)
            atInvBrkDdItems = atInvBrkPairs;
        } else {
            var tokens = wmsTokenize(q);
            atInvBrkDdItems = atInvBrkPairs.filter(function(pair) {
                return wmsMultiTokenMatch(tokens, pair.searchStr);
            });
        }

        dd.innerHTML = '';
        if (atInvBrkDdItems.length === 0) {
            dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No matches</div>';
        } else {
            atInvBrkDdItems.forEach(function(pair, idx) {
                var div = document.createElement('div');
                div.className = 'wms-dd-item';
                div.dataset.idx = idx;
                var invLabel = pair.investor.short_name || pair.investor.name;
                var brkLabel = pair.broker.broker_code || pair.broker.name;
                div.innerHTML = '<span style="font-weight:600;">' + invLabel + '</span>' +
                    '<span style="color:#a0aec0;margin:0 4px;">&gt;</span>' +
                    '<span>' + brkLabel + '</span>' +
                    '<span class="sub">' + pair.investor.name + ' — ' + pair.broker.name + '</span>';
                dd.appendChild(div);
            });
        }
        atInvBrkDdCtrl.show();
        atInvBrkDdCtrl.resetIdx();
    });

    // Mouse click support on dropdown items
    dd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wms-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        if (idx >= 0 && idx < atInvBrkDdItems.length) {
            selectAddTxnInvBrk(atInvBrkDdItems[idx]);
        }
        atInvBrkDdCtrl.close();
    });

    input.addEventListener('focus', function() {
        if (atSelectedInvestor) return;
        // Show all pairs on focus
        input.dispatchEvent(new Event('input'));
    });

    // Segmented date input
    atInitDateWidget();
}

function selectAddTxnInvBrk(pair) {
    atSelectedInvestor = pair.investor;
    atSelectedBroker = pair.broker;
    var input = document.getElementById('addTxnInvBrkInput');
    input.value = pair.label;
    input.disabled = true;

    document.getElementById('addTxnInvBrkBadge').innerHTML =
        '<span class="addTxn-selected-badge">' + pair.label +
        '<span class="clear" onclick="clearAddTxnInvBrk()">&times;</span></span>';

    // Focus first row symbol
    setTimeout(function() {
        var firstSym = document.querySelector('.addTxn-sym-input');
        if (firstSym) firstSym.focus();
    }, 50);
}

function clearAddTxnInvBrk() {
    atSelectedInvestor = null;
    atSelectedBroker = null;
    var input = document.getElementById('addTxnInvBrkInput');
    input.value = '';
    input.disabled = false;
    document.getElementById('addTxnInvBrkBadge').innerHTML = '';
    input.focus();
}

window.clearAddTxnInvBrk = clearAddTxnInvBrk;

// ============================================================================
// Segmented Date Widget (dd-mmm-yyyy)
// ============================================================================

var AT_MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var atDateState = { day: 1, month: 0, year: 2026 }; // current date values
var atDateActiveSeg = null; // 'dd', 'mmm', or 'yyyy'
var atDateTypeBuf = '';     // typed characters buffer
var atDateTypeTimer = null; // clear buffer after delay

function atFormatDateDisplay(date) {
    var dd = String(date.getDate()).padStart(2, '0');
    var mmm = AT_MONTHS_SHORT[date.getMonth()];
    var yyyy = date.getFullYear();
    return dd + '-' + mmm + '-' + yyyy;
}

function atInitDateWidget() {
    var wrap = document.getElementById('addTxnDateWrap');
    var segs = wrap.querySelectorAll('.atDate-seg');

    // Click on a segment to activate it
    segs.forEach(function(seg) {
        seg.addEventListener('mousedown', function(e) {
            e.preventDefault(); // prevent blur
            atDateSetActive(seg.dataset.seg);
            wrap.focus();
        });
    });

    // Click on wrap focuses dd by default
    wrap.addEventListener('mousedown', function(e) {
        if (e.target === wrap) {
            e.preventDefault();
            atDateSetActive('dd');
            wrap.focus();
        }
    });

    // Keyboard navigation
    wrap.addEventListener('keydown', function(e) {
        if (!atDateActiveSeg) atDateSetActive('dd');

        var key = e.key;

        if (key === 'ArrowLeft') {
            e.preventDefault();
            atDateMoveSeg(-1);
        } else if (key === 'ArrowRight') {
            e.preventDefault();
            atDateMoveSeg(1);
        } else if (key === 'ArrowUp') {
            e.preventDefault();
            atDateAdjust(1);
        } else if (key === 'ArrowDown') {
            e.preventDefault();
            atDateAdjust(-1);
        } else if (key === 'Tab') {
            // Tab within segments, then exit to next field
            if (!e.shiftKey && atDateActiveSeg !== 'yyyy') {
                e.preventDefault();
                atDateMoveSeg(1);
            } else if (e.shiftKey && atDateActiveSeg !== 'dd') {
                e.preventDefault();
                atDateMoveSeg(-1);
            } else {
                // Let Tab leave the widget naturally
                atDateClearActive();
            }
        } else if (key === 'Enter') {
            e.preventDefault();
            if (atDateActiveSeg !== 'yyyy') {
                atDateMoveSeg(1);
            } else {
                // Exit to next field (investor-broker)
                atDateClearActive();
                var nextInput = document.getElementById('addTxnInvBrkInput');
                if (nextInput && !nextInput.disabled) nextInput.focus();
            }
        } else if (/^[0-9]$/.test(key)) {
            e.preventDefault();
            atDateTypeDigit(key);
        } else if (/^[a-zA-Z]$/.test(key)) {
            e.preventDefault();
            atDateTypeLetter(key);
        }
    });

    // Focus/blur
    wrap.addEventListener('focus', function() {
        if (!atDateActiveSeg) atDateSetActive('dd');
    });
    wrap.addEventListener('blur', function() {
        atDateClearActive();
    });

    // Calendar icon — opens native date picker, syncs back to segmented widget
    var calBtn = document.getElementById('atDateCalBtn');
    var calPicker = document.getElementById('atDateCalPicker');
    if (calBtn && calPicker) {
        calBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            // Sync current state to the hidden date input
            var mm = String(atDateState.month + 1).padStart(2, '0');
            var dd = String(atDateState.day).padStart(2, '0');
            calPicker.value = atDateState.year + '-' + mm + '-' + dd;
            // Programmatically open the native date picker
            if (typeof calPicker.showPicker === 'function') {
                calPicker.showPicker();
            } else {
                calPicker.focus();
                calPicker.click();
            }
        });
        calPicker.addEventListener('change', function() {
            if (calPicker.value) {
                var parts = calPicker.value.split('-');
                var picked = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                atDateSetFromDate(picked);
            }
        });
    }
}

function atDateSetActive(seg) {
    atDateActiveSeg = seg;
    atDateTypeBuf = '';
    var wrap = document.getElementById('addTxnDateWrap');
    wrap.querySelectorAll('.atDate-seg').forEach(function(el) {
        el.classList.toggle('active', el.dataset.seg === seg);
    });
}

function atDateClearActive() {
    atDateActiveSeg = null;
    atDateTypeBuf = '';
    var wrap = document.getElementById('addTxnDateWrap');
    if (wrap) {
        wrap.querySelectorAll('.atDate-seg').forEach(function(el) {
            el.classList.remove('active');
        });
    }
}

function atDateMoveSeg(dir) {
    var order = ['dd', 'mmm', 'yyyy'];
    var idx = order.indexOf(atDateActiveSeg);
    var next = idx + dir;
    if (next >= 0 && next < order.length) {
        atDateSetActive(order[next]);
    }
}

function atDateAdjust(delta) {
    if (atDateActiveSeg === 'dd') {
        atDateState.day += delta;
        var maxDay = atDateDaysInMonth(atDateState.month, atDateState.year);
        if (atDateState.day > maxDay) atDateState.day = 1;
        if (atDateState.day < 1) atDateState.day = maxDay;
    } else if (atDateActiveSeg === 'mmm') {
        atDateState.month += delta;
        if (atDateState.month > 11) atDateState.month = 0;
        if (atDateState.month < 0) atDateState.month = 11;
        // Clamp day to valid range
        var maxD = atDateDaysInMonth(atDateState.month, atDateState.year);
        if (atDateState.day > maxD) atDateState.day = maxD;
    } else if (atDateActiveSeg === 'yyyy') {
        atDateState.year += delta;
        if (atDateState.year < 2000) atDateState.year = 2000;
        if (atDateState.year > 2099) atDateState.year = 2099;
        var maxD2 = atDateDaysInMonth(atDateState.month, atDateState.year);
        if (atDateState.day > maxD2) atDateState.day = maxD2;
    }
    atDateRender();
}

function atDateTypeDigit(digit) {
    clearTimeout(atDateTypeTimer);

    if (atDateActiveSeg === 'dd') {
        atDateTypeBuf += digit;
        if (atDateTypeBuf.length >= 2) {
            var val = parseInt(atDateTypeBuf);
            var maxDay = atDateDaysInMonth(atDateState.month, atDateState.year);
            if (val >= 1 && val <= maxDay) atDateState.day = val;
            atDateTypeBuf = '';
            atDateRender();
            atDateMoveSeg(1); // auto-advance to month
        } else {
            // If first digit > 3, accept immediately (can't be a valid 2-digit day start > 31)
            var first = parseInt(atDateTypeBuf);
            if (first > 3) {
                if (first >= 1) atDateState.day = first;
                atDateTypeBuf = '';
                atDateRender();
                atDateMoveSeg(1);
            } else {
                // Show typed digit, wait for second
                atDateRender();
                atDateTypeTimer = setTimeout(function() {
                    if (atDateTypeBuf.length === 1) {
                        var v = parseInt(atDateTypeBuf);
                        if (v >= 1) atDateState.day = v;
                        atDateTypeBuf = '';
                        atDateRender();
                        atDateMoveSeg(1);
                    }
                }, 800);
            }
        }
    } else if (atDateActiveSeg === 'yyyy') {
        atDateTypeBuf += digit;
        if (atDateTypeBuf.length >= 4) {
            var yr = parseInt(atDateTypeBuf);
            if (yr >= 2000 && yr <= 2099) atDateState.year = yr;
            atDateTypeBuf = '';
            atDateRender();
        } else {
            atDateTypeTimer = setTimeout(function() {
                // Accept partial year entry
                atDateTypeBuf = '';
            }, 1500);
        }
    } else if (atDateActiveSeg === 'mmm') {
        // Digits 1-12 for month
        atDateTypeBuf += digit;
        if (atDateTypeBuf.length >= 2) {
            var mVal = parseInt(atDateTypeBuf);
            if (mVal >= 1 && mVal <= 12) atDateState.month = mVal - 1;
            atDateTypeBuf = '';
            atDateRender();
            atDateMoveSeg(1); // auto-advance to year
        } else {
            var mFirst = parseInt(atDateTypeBuf);
            if (mFirst > 1) {
                if (mFirst >= 1 && mFirst <= 9) atDateState.month = mFirst - 1;
                atDateTypeBuf = '';
                atDateRender();
                atDateMoveSeg(1);
            } else {
                atDateTypeTimer = setTimeout(function() {
                    if (atDateTypeBuf.length === 1) {
                        var v = parseInt(atDateTypeBuf);
                        if (v >= 1) atDateState.month = v - 1;
                        atDateTypeBuf = '';
                        atDateRender();
                        atDateMoveSeg(1);
                    }
                }, 800);
            }
        }
    }
}

function atDateTypeLetter(letter) {
    if (atDateActiveSeg !== 'mmm') return;
    clearTimeout(atDateTypeTimer);
    atDateTypeBuf += letter.toLowerCase();

    // Match against month names
    var matched = -1;
    for (var i = 0; i < AT_MONTHS_SHORT.length; i++) {
        if (AT_MONTHS_SHORT[i].toLowerCase().indexOf(atDateTypeBuf) === 0) {
            matched = i;
            break;
        }
    }
    if (matched >= 0) {
        atDateState.month = matched;
        atDateRender();
    }
    // If typed 3 chars, auto-advance
    if (atDateTypeBuf.length >= 3) {
        atDateTypeBuf = '';
        atDateMoveSeg(1);
    } else {
        atDateTypeTimer = setTimeout(function() { atDateTypeBuf = ''; }, 800);
    }
}

function atDateDaysInMonth(month, year) {
    return new Date(year, month + 1, 0).getDate();
}

function atDateRender() {
    document.getElementById('atDateDd').textContent = String(atDateState.day).padStart(2, '0');
    document.getElementById('atDateMmm').textContent = AT_MONTHS_SHORT[atDateState.month];
    document.getElementById('atDateYyyy').textContent = String(atDateState.year);
    // Sync hidden input (yyyy-mm-dd for DB)
    var mm = String(atDateState.month + 1).padStart(2, '0');
    var dd = String(atDateState.day).padStart(2, '0');
    document.getElementById('addTxnDate').value = atDateState.year + '-' + mm + '-' + dd;
}

function atDateSetFromDate(date) {
    atDateState.day = date.getDate();
    atDateState.month = date.getMonth();
    atDateState.year = date.getFullYear();
    atDateRender();
}

function atDateGetDisplayStr() {
    return String(atDateState.day).padStart(2, '0') + '-' + AT_MONTHS_SHORT[atDateState.month] + '-' + atDateState.year;
}

// ============================================================================
// Row Management
// ============================================================================

function addAddTxnRow(copyFromId) {
    var copyFrom = null;
    if (copyFromId !== undefined) {
        copyFrom = atRows.find(function(r) { return r.rowId === copyFromId; });
    }

    var rowId = atNextRowId++;
    var row = {
        rowId: rowId,
        trader_id: copyFrom ? copyFrom.trader_id : null,
        security_id: copyFrom ? copyFrom.security_id : null,
        symbol: copyFrom ? copyFrom.symbol : '',
        short_symbol: copyFrom ? copyFrom.short_symbol : '',
        company_name: copyFrom ? copyFrom.company_name : '',
        security_type: copyFrom ? copyFrom.security_type : 'EQUITY',
        asset_class: copyFrom ? copyFrom.asset_class : null,
        exchange: copyFrom ? copyFrom.exchange : 'NSE',
        lot_size: copyFrom ? copyFrom.lot_size : 1,
        lots: copyFrom ? copyFrom.lots : 0,
        quantity: copyFrom ? copyFrom.quantity : 0,
        price: copyFrom ? copyFrom.price : 0,
        gross_amount: copyFrom ? copyFrom.gross_amount : 0,
        brokerage: 0,
        stt: 0,
        other_charges: 0,
        gst: 0,
        total_charges: 0,
        trader_charges: 0,
        net_amount: 0,
        tags: copyFrom ? copyFrom.tags.slice() : [],
        _exchange_charges: 0,
        _sebi_charges: 0,
        _stamp_duty: 0,
        _ipft: 0,
        _chargesBasis: {},
        _grossOverride: false,
        _totalOverride: false,
        _trdChgOverride: false,
        _netOverride: false
    };

    atRows.push(row);

    // Build HTML
    var isNfo = row.lot_size > 1;
    var traderOptions = '<option value="">(Same)</option>';
    atInvestors.forEach(function(inv) {
        var sel = (row.trader_id && inv.id === row.trader_id) ? ' selected' : '';
        traderOptions += '<option value="' + inv.id + '"' + sel + '>' + (inv.short_name || inv.name) + '</option>';
    });

    var tr = document.createElement('tr');
    tr.dataset.rowId = rowId;
    tr.innerHTML =
        // Trader
        '<td><select class="addTxn-trader-sel" data-rid="' + rowId + '">' + traderOptions + '</select></td>' +
        // Symbol
        '<td style="position:relative;">' +
            '<input type="text" class="addTxn-sym-input" data-rid="' + rowId + '" placeholder="Search..." autocomplete="off" value="' + (row.symbol || '') + '">' +
            '<div class="addTxn-sym-dd" id="addTxnSymDd_' + rowId + '"></div>' +
        '</td>' +
        // Lots
        '<td><input type="number" class="addTxn-lots-input' + (isNfo ? '' : ' disabled-lots') + '" data-rid="' + rowId + '" step="1" value="' + (row.lots || '') + '"' + (isNfo ? '' : ' disabled') + '></td>' +
        // Qty
        '<td><input type="text" class="addTxn-qty-input addTxn-amt-field" data-rid="' + rowId + '" value="' + atFmtQty(row.quantity) + '"></td>' +
        // Price
        '<td><input type="text" class="addTxn-price-input addTxn-amt-field" data-rid="' + rowId + '" inputmode="decimal" value="' + atFmtPrice(row.price) + '"></td>' +
        // Gross (editable)
        '<td><input type="text" class="addTxn-gross-input addTxn-amt-field" data-rid="' + rowId + '" value="' + atFmtAmt(row.gross_amount) + '"></td>' +
        // Total charges (editable, dblclick for breakdown)
        '<td><input type="text" class="addTxn-totchg-input addTxn-amt-field" data-rid="' + rowId + '" value="' + atFmtAmt(row.total_charges) + '" title="Double-click for breakdown"></td>' +
        // Trader charges (editable)
        '<td><input type="text" class="addTxn-trdchg-input addTxn-amt-field" data-rid="' + rowId + '" value="' + atFmtAmt(row.trader_charges) + '"></td>' +
        // Net amount (editable)
        '<td><input type="text" class="addTxn-net-input addTxn-amt-field" data-rid="' + rowId + '" value="' + atFmtAmt(row.net_amount) + '"></td>' +
        // Tags
        '<td style="position:relative;">' +
            '<input type="text" class="addTxn-tags-input" data-rid="' + rowId + '" placeholder="Tags..." autocomplete="off">' +
            '<div class="addTxn-tag-pills" id="addTxnTagPills_' + rowId + '"></div>' +
            '<div class="addTxn-tag-dd" id="addTxnTagDd_' + rowId + '"></div>' +
        '</td>' +
        // Delete
        '<td><button class="addTxn-del-btn" data-rid="' + rowId + '" title="Remove row">&#x1F5D1;</button></td>';

    document.getElementById('addTxnTbody').appendChild(tr);

    // Attach handlers
    attachAddTxnRowHandlers(rowId);

    // Recalc charges if copying (has security + qty + price)
    if (copyFrom && row.security_id && row.quantity && row.price) {
        recalcAddTxnRow(rowId);
    }

    // Render tag pills if copying
    if (row.tags.length > 0) {
        renderAddTxnTagPills(rowId);
    }

    // Show balance on copied rows that already have a symbol
    if (copyFrom && row.security_id) {
        atShowBalanceQtyTooltip(rowId, row);
    }

    return rowId;
}

function removeAddTxnRow(rowId) {
    if (atRows.length <= 1) return; // Keep at least one row
    atRows = atRows.filter(function(r) { return r.rowId !== rowId; });
    var tr = document.querySelector('#addTxnTbody tr[data-row-id="' + rowId + '"]');
    if (tr) tr.remove();
}

// ============================================================================
// Row Event Handlers
// ============================================================================

function attachAddTxnRowHandlers(rowId) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    var traderSel = document.querySelector('.addTxn-trader-sel[data-rid="' + rowId + '"]');
    var symInput = document.querySelector('.addTxn-sym-input[data-rid="' + rowId + '"]');
    var lotsInput = document.querySelector('.addTxn-lots-input[data-rid="' + rowId + '"]');
    var qtyInput = document.querySelector('.addTxn-qty-input[data-rid="' + rowId + '"]');
    var priceInput = document.querySelector('.addTxn-price-input[data-rid="' + rowId + '"]');
    var tagsInput = document.querySelector('.addTxn-tags-input[data-rid="' + rowId + '"]');
    var grossInput = document.querySelector('.addTxn-gross-input[data-rid="' + rowId + '"]');
    var totchgInput = document.querySelector('.addTxn-totchg-input[data-rid="' + rowId + '"]');
    var trdchgInput = document.querySelector('.addTxn-trdchg-input[data-rid="' + rowId + '"]');
    var netInput = document.querySelector('.addTxn-net-input[data-rid="' + rowId + '"]');
    var delBtn = document.querySelector('.addTxn-del-btn[data-rid="' + rowId + '"]');

    // --- Trader change ---
    traderSel.addEventListener('change', function() {
        row.trader_id = traderSel.value || null;
        recalcAddTxnRow(rowId);
        // Refresh balance and tags for the new trader
        if (row.security_id) {
            atShowBalanceQtyTooltip(rowId, row);
            atAutoPopulateTags(rowId, row);
        }
    });

    // --- Symbol search ---
    var symSearchTimer = null;
    var dd = document.getElementById('addTxnSymDd_' + rowId);

    // Create wmsDropdown for this row's symbol search
    atSymDdCtrls[rowId] = wmsDropdown(symInput, dd, {
        onSelect: function(itemEl) {
            var idx = parseInt(itemEl.dataset.idx);
            if (idx >= 0 && atSymDdItems[rowId] && idx < atSymDdItems[rowId].length) {
                var sec = atSymDdItems[rowId][idx];
                // Check if this is an options contract (has _fyersSymbol field)
                if (sec._fyersSymbol) {
                    atSelectOptionsContract(rowId, sec._fyersSymbol, sec._parsed, sec._displayLabel);
                } else {
                    selectAddTxnSecurity(rowId, sec);
                }
            }
        },
        itemSelector: '.wms-dd-item',
        closeOnSelect: true,
        blurDelay: 200,
        escClearsInput: false
    });

    symInput.addEventListener('input', function() {
        clearTimeout(symSearchTimer);
        var q = symInput.value.trim();
        if (q.length < 2) {
            atSymDdCtrls[rowId].close();
            return;
        }
        symSearchTimer = setTimeout(function() { searchAddTxnSymbol(rowId, q); }, 300);
    });

    // Mouse click support on symbol dropdown items
    dd.addEventListener('mousedown', function(e) {
        var item = e.target.closest('.wms-dd-item');
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.dataset.idx);
        if (idx >= 0 && atSymDdItems[rowId] && idx < atSymDdItems[rowId].length) {
            var sec = atSymDdItems[rowId][idx];
            if (sec._fyersSymbol) {
                atSelectOptionsContract(rowId, sec._fyersSymbol, sec._parsed, sec._displayLabel);
            } else {
                selectAddTxnSecurity(rowId, sec);
            }
        }
        atSymDdCtrls[rowId].close();
    });

    // --- Lots change ---
    lotsInput.addEventListener('input', function() {
        var lots = parseFloat(lotsInput.value) || 0;
        row.lots = lots;
        if (row.lot_size > 1) {
            row.quantity = Math.round(lots * row.lot_size);
            qtyInput.value = atFmtQty(row.quantity);
        }
        recalcAddTxnRow(rowId);
    });

    // --- Qty focus/blur formatting ---
    qtyInput.addEventListener('focus', function() {
        var raw = parseInt(qtyInput.value.replace(/,/g, '')) || 0;
        qtyInput.value = raw || '';
    });
    qtyInput.addEventListener('blur', function() {
        var raw = parseInt(qtyInput.value.replace(/,/g, '')) || 0;
        qtyInput.value = atFmtQty(raw);
    });

    // --- Qty change ---
    qtyInput.addEventListener('input', function() {
        var qty = parseInt(qtyInput.value.replace(/,/g, '')) || 0;
        row.quantity = qty;
        if (row.lot_size > 1 && qty !== 0) {
            row.lots = Math.round(Math.abs(qty) / row.lot_size * 100) / 100;
            if (qty < 0) row.lots = -Math.abs(row.lots);
            lotsInput.value = row.lots || '';
        }
        // Qty change clears gross/net overrides — auto-calc resumes
        row._grossOverride = false;
        row._netOverride = false;
        recalcAddTxnRow(rowId);
    });

    // --- Price focus/blur formatting ---
    priceInput.addEventListener('focus', function() {
        var raw = parseFloat(priceInput.value.replace(/,/g, '')) || 0;
        priceInput.value = raw || '';
    });
    priceInput.addEventListener('blur', function() {
        var raw = parseFloat(priceInput.value.replace(/,/g, '')) || 0;
        priceInput.value = atFmtPrice(raw);
    });

    // --- Price change ---
    priceInput.addEventListener('input', function() {
        row.price = parseFloat(priceInput.value.replace(/,/g, '')) || 0;
        // Price change clears gross/net overrides — auto-calc resumes
        row._grossOverride = false;
        row._netOverride = false;
        recalcAddTxnRow(rowId);
    });

    // --- Amount field focus/blur formatting (show raw on focus, formatted on blur) ---
    [grossInput, totchgInput, trdchgInput, netInput].forEach(function(el) {
        el.addEventListener('focus', function() {
            var raw = parseFloat(el.value.replace(/,/g, '')) || 0;
            el.value = raw || '';
        });
        el.addEventListener('blur', function() {
            var raw = parseFloat(el.value.replace(/,/g, '')) || 0;
            el.value = atFmtAmt(raw);
        });
    });

    // --- Gross amount input ---
    grossInput.addEventListener('input', function() {
        row.gross_amount = parseFloat(grossInput.value.replace(/,/g, '')) || 0;
        row._grossOverride = true;
        recalcAddTxnRow(rowId);
    });

    // --- Total charges input ---
    totchgInput.addEventListener('input', function() {
        row.total_charges = parseFloat(totchgInput.value.replace(/,/g, '')) || 0;
        row._totalOverride = true;
        recalcAddTxnRow(rowId);
    });

    // --- Total charges dblclick → popover ---
    totchgInput.addEventListener('dblclick', function() {
        openAddTxnCp(rowId);
    });

    // --- Trader charges input ---
    trdchgInput.addEventListener('input', function() {
        row.trader_charges = parseFloat(trdchgInput.value.replace(/,/g, '')) || 0;
        row._trdChgOverride = true;
        recalcAddTxnRow(rowId);
    });

    // --- Net amount input ---
    netInput.addEventListener('input', function() {
        row.net_amount = parseFloat(netInput.value.replace(/,/g, '')) || 0;
        row._netOverride = true;
        updateAddTxnRowDisplay(rowId);
    });

    // --- Tags autocomplete ---
    setupAddTxnTagInput(rowId);

    // --- Delete row ---
    delBtn.addEventListener('click', function() { removeAddTxnRow(rowId); });

    // --- Keyboard: Tab navigation ---
    var tabbable = [traderSel, symInput, lotsInput, qtyInput, priceInput, grossInput, totchgInput, trdchgInput, netInput, tagsInput];
    tabbable.forEach(function(field, idx) {
        field.addEventListener('keydown', function(e) {
            if (e.key === 'Tab' && !e.shiftKey) {
                // If on tags field (last), add new row
                if (field === tagsInput) {
                    e.preventDefault();
                    // Add tag text if any typed
                    var typed = tagsInput.value.trim();
                    if (typed.length > 0) addAddTxnTagFromText(rowId, typed);
                    var newId = addAddTxnRow(rowId);
                    setTimeout(function() {
                        var newTrader = document.querySelector('.addTxn-trader-sel[data-rid="' + newId + '"]');
                        if (newTrader) newTrader.focus();
                    }, 50);
                }
            }
            // Enter on trader or tags → submit
            if (e.key === 'Enter') {
                if (field === traderSel) {
                    e.preventDefault();
                    openAddTxnConfirmation();
                } else if (field === tagsInput) {
                    // Only submit if no tag text to add, and dropdown is not showing
                    var tagDd = document.getElementById('addTxnTagDd_' + rowId);
                    var typed2 = tagsInput.value.trim();
                    if (typed2.length > 0) {
                        e.preventDefault();
                        addAddTxnTagFromText(rowId, typed2);
                    } else if (!tagDd.classList.contains('show')) {
                        e.preventDefault();
                        openAddTxnConfirmation();
                    }
                }
            }
        });
    });
}

// ============================================================================
// SYMBOL SEARCH
// Options parsing & candidate building delegated to wms-shared.js.
// See WMS-LESSONS.md Section B.9 for the shared module inventory.
// ============================================================================

// --- Options functions: delegated to wms-shared.js ---
function atParseOptionsQuery(query) { return wmsParseOptionsQuery(query); }
function atBuildOptionsCandidates(underlying, strike, optionType, expiryHint) { return wmsBuildOptionsCandidates(underlying, strike, optionType, expiryHint); }
function atFormatOptionsDisplay(fyersSymbol, underlying, strike, optionType) { return wmsFormatOptionsDisplay(fyersSymbol, underlying, strike, optionType); }

// --- Options search via Fyers API (ported from trWlSearchOptions) ---
async function atSearchOptions(rowId, parsed, dd) {
    if (!window.fyersToken) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">Fyers not connected — cannot search options.<br>Options search requires an active Fyers connection.</div>';
        dd.classList.add('show');
        return;
    }
    dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">Searching options...</div>';
    dd.classList.add('show');
    var candidates = atBuildOptionsCandidates(parsed.underlying, parsed.strike, parsed.optionType, parsed.expiryHint);
    if (candidates.length === 0) {
        dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">Could not build option symbols</div>';
        return;
    }
    console.log('AddTxn: Options search candidates:', candidates);
    try {
        var data = await window.fyersCall({ action: 'quotes', symbols: candidates });
        var validResults = [];
        if (data && data.d && data.d.length > 0) {
            data.d.forEach(function(item) {
                if (item.v && item.v.lp > 0) {
                    validResults.push({ symbol: item.v.symbol, lp: item.v.lp, ch: item.v.ch || 0, chp: item.v.chp || 0 });
                }
            });
        }
        if (validResults.length === 0) {
            dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No active options found for "' +
                parsed.underlying + ' ' + parsed.strike + ' ' + parsed.optionType + '"<br>Try a different strike price or expiry month.</div>';
            return;
        }
        dd.innerHTML = '';
        var allSecurities = [];
        validResults.forEach(function(r, idx) {
            var displayLabel = atFormatOptionsDisplay(r.symbol, parsed.underlying, parsed.strike, parsed.optionType);
            var div = document.createElement('div');
            div.className = 'wms-dd-item nfo';
            div.dataset.idx = idx;
            div.innerHTML = displayLabel +
                ' <span class="sub">₹' + r.lp.toFixed(2) + '</span>' +
                ' <span class="sub" style="color:' + (r.chp >= 0 ? '#059669' : '#dc2626') + ';">' +
                (r.chp >= 0 ? '+' : '') + r.chp.toFixed(2) + '%</span>';
            dd.appendChild(div);
            allSecurities.push({
                _fyersSymbol: r.symbol,
                _displayLabel: displayLabel,
                _parsed: parsed
            });
        });
        atSymDdItems[rowId] = allSecurities;
        atSymDdCtrls[rowId].show();
        atSymDdCtrls[rowId].resetIdx();
    } catch (err) {
        dd.innerHTML = '<div style="padding:8px;color:#dc2626;font-size:11px;">Options search failed: ' + err.message + '</div>';
    }
}

// --- Select an options contract from Fyers search results ---
async function atSelectOptionsContract(rowId, fyersSymbol, parsed, displayLabel) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;
    // Try to find this in securities_nfo first (may have been added via watchlist)
    var headers = wmsHeaders();
    var nfoCheck = SUPABASE_URL + '/rest/v1/securities_nfo?symbol=eq.' + encodeURIComponent(fyersSymbol.split(':')[1] || fyersSymbol) +
        '&select=id,symbol,underlying_symbol,instrument_name,exchange,instrument_type,lot_size,broker_tokens,expiry_date&limit=1';
    var nfoResp = await fetch(nfoCheck, { headers: headers }).then(function(r) { return r.ok ? r.json() : []; }).catch(function() { return []; });
    var lotSize = 1;
    var secId = null;
    if (nfoResp.length > 0) {
        var nfo = nfoResp[0];
        lotSize = nfo.lot_size || 1;
        secId = nfo.id;
    } else {
        // Security not in DB — estimate lot size, then create it
        var lotCheck = SUPABASE_URL + '/rest/v1/securities_nfo?underlying_symbol=eq.' + encodeURIComponent(parsed.underlying) +
            '&select=lot_size&limit=1';
        var lotResp = await fetch(lotCheck, { headers: headers }).then(function(r) { return r.ok ? r.json() : []; }).catch(function() { return []; });
        if (lotResp.length > 0) lotSize = lotResp[0].lot_size || 1;

        // Build NFO record and insert into securities_nfo
        var bareSym = fyersSymbol.split(':')[1] || fyersSymbol;
        var instrType = parsed.optionType ? 'OPTIONS' : 'FUTURES';
        var instrName = displayLabel || (parsed.underlying + ' ' +
            (parsed.strike ? parsed.strike + ' ' + parsed.optionType : 'FUT'));
        // Parse expiry date from the Fyers symbol (e.g. MANAPPURAM26MAR255CE → 26MAR → 2026-03-28)
        var expiryDate = null;
        var MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        var symExpMatch = bareSym.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/);
        if (symExpMatch) {
            var yr = 2000 + parseInt(symExpMatch[1]);
            var monIdx = MONTHS_SHORT.indexOf(symExpMatch[2]);
            expiryDate = yr + '-' + String(monIdx + 1).padStart(2, '0') + '-28';
        }
        var nfoRecord = {
            symbol: bareSym,
            instrument_name: instrName,
            exchange: fyersSymbol.split(':')[0] || 'NSE',
            instrument_type: instrType,
            underlying_symbol: parsed.underlying,
            expiry_date: expiryDate,
            strike_price: parsed.strike || null,
            option_type: parsed.optionType || null,
            lot_size: lotSize,
            is_active: true,
            broker_tokens: {}
        };
        try {
            var createResp = await fetch(SUPABASE_URL + '/rest/v1/securities_nfo', {
                method: 'POST',
                headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
                body: JSON.stringify(nfoRecord)
            });
            if (createResp.ok) {
                var created = await createResp.json();
                if (created && created.length > 0) {
                    secId = created[0].id;
                    console.log('NFO security created: ' + bareSym + ' → ' + secId);
                    // Persist Fyers broker_token via quotes API (background, non-blocking)
                    if (secId && fyersSymbol && typeof wmsUpdateNfoBrokerToken === 'function') {
                        wmsUpdateNfoBrokerToken(secId, fyersSymbol);
                    }
                    // Refresh local NFO cache in background
                    if (typeof wmsLoadSecuritiesNfo === 'function') wmsLoadSecuritiesNfo();
                }
            } else {
                var errBody = await createResp.json().catch(function() { return {}; });
                console.error('NFO security create failed:', errBody);
                showAlert('Could not register NFO security: ' + (errBody.message || 'DB error'), 'error', 5000);
                return;
            }
        } catch (createErr) {
            console.error('NFO security create error:', createErr);
            showAlert('Could not register NFO security: ' + createErr.message, 'error', 5000);
            return;
        }
    }
    selectAddTxnSecurity(rowId, {
        security_id: secId,
        symbol: fyersSymbol.split(':')[1] || fyersSymbol,
        short_symbol: parsed.underlying,
        company_name: displayLabel || (parsed.underlying + ' Option'),
        security_type: 'NFO',
        asset_class: 'OPTIONS',
        exchange: fyersSymbol.split(':')[0] || 'NSE',
        lot_size: lotSize,
        broker_tokens: {}
    });
}

async function searchAddTxnSymbol(rowId, query) {
    var dd = document.getElementById('addTxnSymDd_' + rowId);

    // Check if this is an options query (contains CE/PE + strike) — same logic as watchlist
    var optionsParsed = atParseOptionsQuery(query);
    if (optionsParsed) {
        await atSearchOptions(rowId, optionsParsed, dd);
        return;
    }

    try {
        // Ensure securities cache is loaded (wait if still downloading on startup)
        if (!wmsRefData.securitiesCmReady || !wmsRefData.securitiesNfoReady) {
            dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">Loading securities data...</div>';
            atSymDdCtrls[rowId].show();
            if (!wmsRefData.securitiesCmReady) await wmsLoadSecuritiesCm(0, {all: true});
            if (!wmsRefData.securitiesNfoReady) await wmsLoadSecuritiesNfo();
        }

        // Client-side search from shared cache (no network calls)
        var cached = wmsSearchSecurities(query);

        // Build combined security results array for the dropdown controller
        var allSecurities = [];

        // CM results from cache
        cached.forEach(function(sec) {
            if (sec._isNfo) {
                var isOpt = sec.symbol && (sec.symbol.match(/(CE|PE)$/) !== null);
                allSecurities.push({
                    security_id: sec.id,
                    symbol: sec.symbol,
                    short_symbol: sec.underlying_symbol || sec.symbol,
                    company_name: sec.instrument_name || sec.symbol,
                    security_type: 'NFO',
                    asset_class: isOpt ? 'OPTIONS' : 'FUTURES',
                    exchange: sec.exchange || 'NSE',
                    lot_size: sec.lot_size || 1,
                    broker_tokens: sec.broker_tokens,
                    _displaySym: sec.symbol,
                    _displayExpiry: sec.expiry_date,
                    _isNfo: true
                });
            } else {
                allSecurities.push({
                    security_id: sec.id,
                    symbol: sec.nse_symbol || sec.bse_symbol || sec.symbol,
                    short_symbol: sec.nse_symbol || sec.bse_symbol || sec.symbol,
                    company_name: sec.company_name || sec.symbol,
                    security_type: sec.security_type || 'EQUITY',
                    asset_class: sec.asset_class || null,
                    exchange: sec.nse_symbol ? 'NSE' : 'BSE',
                    lot_size: sec.lot_size || 1,
                    broker_tokens: sec.broker_tokens,
                    _displaySym: sec.nse_symbol || sec.bse_symbol || sec.symbol,
                    _displayName: sec.company_name || '',
                    _isNfo: false
                });
            }
        });
        atSymDdItems[rowId] = allSecurities;

        dd.innerHTML = '';
        if (allSecurities.length === 0) {
            dd.innerHTML = '<div style="padding:8px;color:#a0aec0;font-size:11px;">No matches</div>';
        } else {
            allSecurities.forEach(function(sec, idx) {
                var div = document.createElement('div');
                div.className = sec._isNfo ? 'wms-dd-item nfo' : 'wms-dd-item';
                div.dataset.idx = idx;
                var label = sec._displaySym;
                if (sec._displayExpiry) label += ' <span class="sub">exp ' + sec._displayExpiry + '</span>';
                else if (sec._displayName) label += '<span class="sub">' + sec._displayName + '</span>';
                div.innerHTML = label;
                dd.appendChild(div);
            });
        }
        atSymDdCtrls[rowId].show();
        atSymDdCtrls[rowId].resetIdx();
    } catch (e) {
        console.error('Symbol search error:', e);
    }
}

function selectAddTxnSecurity(rowId, sec) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    row.security_id = sec.security_id;
    row.symbol = sec.symbol;
    row.short_symbol = sec.short_symbol;
    row.company_name = sec.company_name;
    row.security_type = sec.security_type;
    row.asset_class = sec.asset_class;
    row.exchange = sec.exchange;
    row.lot_size = sec.lot_size || 1;

    // Update symbol input display
    var symInput = document.querySelector('.addTxn-sym-input[data-rid="' + rowId + '"]');
    symInput.value = sec.symbol;

    // Enable/disable lots field
    var lotsInput = document.querySelector('.addTxn-lots-input[data-rid="' + rowId + '"]');
    if (sec.lot_size > 1) {
        lotsInput.disabled = false;
        lotsInput.classList.remove('disabled-lots');
    } else {
        lotsInput.disabled = true;
        lotsInput.classList.add('disabled-lots');
        lotsInput.value = '';
        row.lots = 0;
    }

    // Reset charges for fresh calc
    row.brokerage = 0;
    row.stt = 0;
    row.other_charges = 0;
    row.gst = 0;
    row._exchange_charges = 0;
    row._sebi_charges = 0;
    row._stamp_duty = 0;
    row._ipft = 0;
    row.total_charges = 0;
    row.trader_charges = 0;
    row._totalOverride = false;

    recalcAddTxnRow(rowId);

    // Auto-populate tags from matching transactions (Investor + Trader + Symbol)
    atAutoPopulateTags(rowId, row);

    // Show balance qty tooltip on Qty field
    atShowBalanceQtyTooltip(rowId, row);

    // Focus lots (if NFO) or qty
    setTimeout(function() {
        if (sec.lot_size > 1) lotsInput.focus();
        else document.querySelector('.addTxn-qty-input[data-rid="' + rowId + '"]').focus();
    }, 50);
}

// ============================================================================
// Auto-populate Tags & Balance Qty Tooltip
// ============================================================================

function atAutoPopulateTags(rowId, row) {
    // Look up tags from existing transactions matching investor + trader + symbol.
    // Uses shared wmsFindMatchingTags so CN Import and Fyers Import inherit
    // with identical matching semantics (strips exchange prefix, ignores 'blank',
    // dedupes case-insensitive). See wms-shared.js.
    if (!atSelectedInvestor || !row.security_id) return;
    var investorId = atSelectedInvestor.id;
    var traderId = row.trader_id || investorId;
    var txns = (typeof trTransactions !== 'undefined') ? trTransactions : [];
    var tagList = wmsFindMatchingTags(txns, investorId, traderId, row.symbol);
    if (tagList.length > 0 && row.tags.length === 0) {
        // Push into existing array (don't replace — wmsTagInput holds a reference to it)
        tagList.forEach(function(t) { row.tags.push(t); });
        renderAddTxnTagPills(rowId);
    }
}

function atShowBalanceQtyTooltip(rowId, row) {
    // Calculate balance qty for Investor > Broker > Trader > Symbol from existing transactions
    if (!atSelectedInvestor || !atSelectedBroker || !row.security_id) return;
    var investorId = atSelectedInvestor.id;
    var brokerId = atSelectedBroker.id;
    var traderId = row.trader_id || investorId;
    var symbol = row.symbol;

    var txns = (typeof trTransactions !== 'undefined') ? trTransactions : [];
    var filtered = [];
    for (var i = 0; i < txns.length; i++) {
        var t = txns[i];
        if (t.investor_id === investorId && t.broker_id === brokerId &&
            (t.trader_id || t.investor_id) === traderId && (t.symbol || '').replace(/^[A-Z]+:/, '') === (symbol || '').replace(/^[A-Z]+:/, '') &&
            !t.dont_display) {
            filtered.push(t);
        }
    }
    var calc = wmsCalcAvgCost(filtered);
    var balanceQty = calc.netQuantity;

    // Show balance as tooltip AND as a visible label below the Qty and Lots inputs
    var qtyInput = document.querySelector('.addTxn-qty-input[data-rid="' + rowId + '"]');
    if (qtyInput) {
        qtyInput.title = 'Current holding: ' + formatQuantity(balanceQty);
        var td = qtyInput.closest('td');
        var existing = td.querySelector('.atQty-balance');
        if (existing) existing.remove();
        if (balanceQty !== 0) {
            var lbl = document.createElement('div');
            lbl.className = 'atQty-balance';
            lbl.textContent = 'Bal: ' + formatQuantity(balanceQty);
            td.appendChild(lbl);
        }
    }

    // Also show on Lots field if F&O (lot_size > 1)
    var lotsInput = document.querySelector('.addTxn-lots-input[data-rid="' + rowId + '"]');
    if (lotsInput && row.lot_size > 1) {
        var balanceLots = Math.round(balanceQty / row.lot_size);
        lotsInput.title = 'Current holding: ' + balanceLots + ' lots (' + formatQuantity(balanceQty) + ' qty)';
        var lotsTd = lotsInput.closest('td');
        var existingLots = lotsTd.querySelector('.atQty-balance');
        if (existingLots) existingLots.remove();
        if (balanceLots !== 0) {
            var lotsLbl = document.createElement('div');
            lotsLbl.className = 'atQty-balance';
            lotsLbl.textContent = 'Bal: ' + balanceLots + ' lots';
            lotsTd.appendChild(lotsLbl);
        }
    }
}

// ============================================================================
// Recalculation
// ============================================================================

function recalcAddTxnRow(rowId) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    // Gross = |qty| × price (unless user overrode gross)
    if (!row._grossOverride) {
        row.gross_amount = atRound(Math.abs(row.quantity) * (row.price || 0));
    }

    // Derive transaction_type from qty sign
    row.transaction_type = row.quantity >= 0 ? 'BUY' : 'SELL';

    // Auto-calc charges (reset sub-fields for fresh calc)
    row.brokerage = 0;
    row.stt = 0;
    row.other_charges = 0;
    row.gst = 0;
    row._exchange_charges = 0;
    row._sebi_charges = 0;
    row._stamp_duty = 0;
    row._ipft = 0;
    if (!row._totalOverride) row.total_charges = 0;
    if (!row._trdChgOverride) row.trader_charges = 0;

    atAutoCalcCharges(row);

    // Update DOM
    updateAddTxnRowDisplay(rowId);
}

function updateAddTxnRowDisplay(rowId) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    var grossEl = document.querySelector('.addTxn-gross-input[data-rid="' + rowId + '"]');
    var totchgEl = document.querySelector('.addTxn-totchg-input[data-rid="' + rowId + '"]');
    var trdchgEl = document.querySelector('.addTxn-trdchg-input[data-rid="' + rowId + '"]');
    var netEl = document.querySelector('.addTxn-net-input[data-rid="' + rowId + '"]');

    // Only update value if the field is NOT currently focused (don't overwrite while user types)
    if (grossEl && document.activeElement !== grossEl) grossEl.value = atFmtAmt(row.gross_amount);
    if (totchgEl && document.activeElement !== totchgEl) totchgEl.value = atFmtAmt(row.total_charges);
    if (trdchgEl && document.activeElement !== trdchgEl) trdchgEl.value = atFmtAmt(row.trader_charges);
    if (netEl && document.activeElement !== netEl) {
        netEl.value = atFmtAmt(row.net_amount);
        // Color the net amount based on buy/sell
        netEl.style.color = row.quantity < 0 ? '#dc2626' : '';
    }

    // Total charges override indicator
    if (totchgEl && row._totalOverride) {
        totchgEl.style.color = '#d69e2e';
        totchgEl.title = 'User override';
    } else if (totchgEl) {
        totchgEl.style.color = '';
        totchgEl.title = 'Double-click for breakdown';
    }
}

// ============================================================================
// Charge Calculation — thin wrappers calling wms-shared.js canonical functions
// ============================================================================

function atRound(v) { return wmsRoundMoney(v); }

function atAutoCalcCharges(row) {
    var investorId = atSelectedInvestor ? atSelectedInvestor.id : null;
    var brokerId = atSelectedBroker ? atSelectedBroker.id : null;

    wmsAutoCalcCharges(row, {
        ibaRatesMap: wmsRefData.ibaRatesMap,
        regCharges: wmsRefData.regCharges,
        investorId: investorId,
        brokerId: brokerId,
        preserveExisting: false,  // Add Txn always recalculates fresh
        debug: true
    });
}

// ============================================================================
// Charges Breakdown Popover
// ============================================================================

function openAddTxnCp(rowId) {
    atCpRowId = rowId;
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    document.getElementById('addTxnCpTitle').textContent = 'Charges — ' + (row.symbol || 'Row');

    var basis = row._chargesBasis || {};
    var fields = [
        { key: 'brokerage', label: 'Brokerage', basis: basis.brokerage || '' },
        { key: 'stt', label: 'STT', basis: basis.stt || '' },
        { key: '_exchange_charges', label: 'Exchange Charges', basis: basis._exchange_charges || '' },
        { key: '_sebi_charges', label: 'SEBI Charges', basis: basis._sebi_charges || '' },
        { key: '_stamp_duty', label: 'Stamp Duty', basis: basis._stamp_duty || '' },
        { key: '_ipft', label: 'NSE IPFT', basis: basis._ipft || '' },
        { key: 'gst', label: 'GST', basis: basis.gst || '' }
    ];

    var bodyHtml = '';
    fields.forEach(function(f) {
        var val = row[f.key] || 0;
        var basisHtml = f.basis ? '<span class="addTxn-cp-basis">' + f.basis + '</span>' : '';
        bodyHtml += '<div class="addTxn-cp-row">' +
            '<span class="addTxn-cp-label">' + f.label + basisHtml + '</span>' +
            '<span class="addTxn-cp-value" data-field="' + f.key + '" title="Double-click to edit">' + atFmtAmt(val) + '</span>' +
            '</div>';
    });
    document.getElementById('addTxnCpBody').innerHTML = bodyHtml;

    // Total
    updateAddTxnCpTotal(row);

    // Attach dblclick to values
    document.querySelectorAll('#addTxnCpBody .addTxn-cp-value').forEach(function(el) {
        el.addEventListener('dblclick', function() { startAddTxnCpEdit(el); });
    });

    // Total dblclick
    var totalEl = document.getElementById('addTxnCpTotal');
    totalEl.ondblclick = function() { startAddTxnCpTotalEdit(totalEl); };

    document.getElementById('addTxnCpOverlay').classList.add('show');
}

function closeAddTxnCp() {
    document.getElementById('addTxnCpOverlay').classList.remove('show');
    atCpRowId = null;
}

function updateAddTxnCpTotal(row) {
    var calcTotal = atRound((row.brokerage || 0) + (row.stt || 0) + (row.other_charges || 0) + (row.gst || 0));
    var display = row._totalOverride ? row.total_charges : calcTotal;
    var el = document.getElementById('addTxnCpTotal');
    el.textContent = atFmtAmt(display);
    if (row._totalOverride) {
        el.style.color = '#d69e2e';
        el.title = 'User override (calc: ' + atFmtAmt(calcTotal) + ')';
    } else {
        el.style.color = '';
        el.title = 'Double-click to override';
    }
}

function startAddTxnCpEdit(span) {
    if (span.querySelector('input')) return;
    var field = span.dataset.field;
    var row = atRows.find(function(r) { return r.rowId === atCpRowId; });
    if (!row) return;
    var currentVal = row[field] || 0;

    var input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.value = currentVal;
    input.className = 'charge-edit-input';
    input.style.width = '90px';

    span.innerHTML = '';
    span.appendChild(input);
    input.focus();
    input.select();

    function commit() {
        var newVal = parseFloat(input.value) || 0;
        row[field] = atRound(newVal);

        // Recalc other_charges if a sub-component changed
        if (['_exchange_charges', '_sebi_charges', '_stamp_duty', '_ipft'].indexOf(field) >= 0) {
            row.other_charges = atRound(row._exchange_charges + row._sebi_charges + row._stamp_duty + row._ipft);
        }

        // Recalc total if not overridden
        if (!row._totalOverride) {
            row.total_charges = atRound(row.brokerage + row.stt + row.other_charges + row.gst);
        }

        // Recalc net
        if (!row._netOverride) {
            if (row.transaction_type === 'BUY') {
                row.net_amount = atRound(row.gross_amount + row.total_charges);
            } else {
                row.net_amount = atRound(row.gross_amount - row.total_charges);
            }
        }

        span.textContent = atFmtAmt(row[field]);
        updateAddTxnCpTotal(row);
        updateAddTxnRowDisplay(atCpRowId);
    }

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { span.textContent = atFmtAmt(currentVal); }
    });
    input.addEventListener('blur', function() { setTimeout(commit, 100); });
}

function startAddTxnCpTotalEdit(el) {
    if (el.querySelector('input')) return;
    var row = atRows.find(function(r) { return r.rowId === atCpRowId; });
    if (!row) return;
    var currentVal = row.total_charges || 0;

    var input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.value = currentVal;
    input.className = 'charge-edit-input';
    input.style.width = '90px';

    el.innerHTML = '';
    el.appendChild(input);
    input.focus();
    input.select();

    function commit() {
        var newVal = parseFloat(input.value) || 0;
        row.total_charges = atRound(newVal);
        row._totalOverride = true;

        // Recalc net
        if (!row._netOverride) {
            if (row.transaction_type === 'BUY') {
                row.net_amount = atRound(row.gross_amount + row.total_charges);
            } else {
                row.net_amount = atRound(row.gross_amount - row.total_charges);
            }
        }

        updateAddTxnCpTotal(row);
        updateAddTxnRowDisplay(atCpRowId);
    }

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { el.textContent = atFmtAmt(currentVal); }
    });
    input.addEventListener('blur', function() { setTimeout(commit, 100); });
}

// ============================================================================
// Tag Autocomplete
// ============================================================================

function setupAddTxnTagInput(rowId) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;

    var input = document.querySelector('.addTxn-tags-input[data-rid="' + rowId + '"]');
    var pillsDiv = document.getElementById('addTxnTagPills_' + rowId);
    var dd = document.getElementById('addTxnTagDd_' + rowId);

    // Create wmsTagInput controller
    atTagInputCtrls[rowId] = wmsTagInput(input, pillsDiv, dd, {
        tags: row.tags,
        existingTags: atExistingTags,
        onChange: function() {
            // Tags are automatically updated in row.tags (passed by reference)
        }
    });
}

// Legacy functions — kept as thin delegating stubs if called from other places
function addAddTxnTagFromText(rowId, text) {
    if (atTagInputCtrls[rowId]) {
        var row = atRows.find(function(r) { return r.rowId === rowId; });
        if (!row) return;
        var newTags = text.split(/[,;]/).map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
        var added = false;
        newTags.forEach(function(tag) {
            if (row.tags.indexOf(tag) === -1) {
                row.tags.push(tag);
                added = true;
            }
        });
        if (added) {
            atTagInputCtrls[rowId].refresh();
        }
        var input = document.querySelector('.addTxn-tags-input[data-rid="' + rowId + '"]');
        if (input) input.value = '';
    }
}

function removeAddTxnTag(rowId, tag) {
    var row = atRows.find(function(r) { return r.rowId === rowId; });
    if (!row) return;
    row.tags = row.tags.filter(function(t) { return t !== tag; });
    if (atTagInputCtrls[rowId]) {
        atTagInputCtrls[rowId].refresh();
    }
}

function renderAddTxnTagPills(rowId) {
    if (atTagInputCtrls[rowId]) {
        atTagInputCtrls[rowId].refresh();
    }
}

// showAddTxnTagDd — functionality now handled by wmsTagInput
function showAddTxnTagDd() {}

// ============================================================================
// Confirmation & Save
// ============================================================================

function openAddTxnConfirmation() {
    // Validate
    var errors = [];
    if (!atSelectedInvestor || !atSelectedBroker) errors.push('Investor > Broker not selected');

    atRows.forEach(function(row, idx) {
        if (!row.security_id) errors.push('Row ' + (idx + 1) + ': Symbol not selected');
        if (row.quantity === 0) errors.push('Row ' + (idx + 1) + ': Quantity is zero');
        if (!row.price || row.price <= 0) errors.push('Row ' + (idx + 1) + ': Price must be > 0');
    });

    if (errors.length > 0) {
        showAlert(errors.join('. '), 'error', 5000);
        return;
    }

    // Build confirmation rows (flex divs – no table)
    var cBody = document.getElementById('addTxnConfirmBody');
    cBody.innerHTML = '';
    atRows.forEach(function(row, idx) {
        var type = row.quantity >= 0 ? 'BUY' : 'SELL';
        var typeClass = type === 'BUY' ? 'type-buy' : 'type-sell';
        var div = document.createElement('div');
        div.className = 'atc-row';
        div.innerHTML =
            '<span class="atc-n">' + (idx + 1) + '</span>' +
            '<span class="atc-sym" title="' + row.symbol + '">' + row.symbol + '</span>' +
            '<span class="atc-typ ' + typeClass + '">' + type + '</span>' +
            '<span class="atc-qty">' + formatQuantity(Math.abs(row.quantity)) + '</span>' +
            '<span class="atc-prc">' + formatPrice(row.price) + '</span>' +
            '<span class="atc-amt">' + atFmtAmt(row.net_amount) + '</span>';
        cBody.appendChild(div);
    });

    document.getElementById('addTxnConfirmTitle').textContent = 'Confirm ' + atRows.length + ' Transaction(s)';
    // Show investor > broker and date in confirmation header
    var invLabel = atSelectedInvestor.short_name || atSelectedInvestor.name;
    var brkLabel = atSelectedBroker.broker_code || atSelectedBroker.name;
    var dateDisplay = atDateGetDisplayStr();
    document.getElementById('addTxnConfirmInfo').innerHTML =
        '<span>' + invLabel + '</span> &gt; <span>' + brkLabel + '</span> &nbsp;&middot;&nbsp; ' + dateDisplay;
    document.getElementById('addTxnConfirmOverlay').classList.add('show');
}

function closeAddTxnConfirm() {
    document.getElementById('addTxnConfirmOverlay').classList.remove('show');
}

async function importAddTxnToDb() {
    closeAddTxnConfirm();
    document.getElementById('addTxnSaveBtn').disabled = true;

    // --- Duplicate Detection (same logic as Excel import Stage C) ---
    var txnDate = document.getElementById('addTxnDate').value;
    var investorId = atSelectedInvestor.id;
    var brokerId = atSelectedBroker.id;
    var dupHeaders = wmsHeaders();

    try {
        var dupFilter = 'investor_id=eq.' + investorId + '&broker_id=eq.' + brokerId + '&transaction_date=eq.' + txnDate;
        var dupResp = await fetch(SUPABASE_URL + '/rest/v1/transactions?select=id,symbol,transaction_type,quantity,price&' + dupFilter, { headers: dupHeaders });
        var existingTxns = dupResp.ok ? await dupResp.json() : [];

        if (existingTxns.length > 0) {
            // Check each row for duplicates
            var dupes = [];
            atRows.forEach(function(row, idx) {
                var txnType = row.quantity >= 0 ? 'BUY' : 'SELL';
                for (var e = 0; e < existingTxns.length; e++) {
                    var ex = existingTxns[e];
                    if ((ex.symbol || '').replace(/^[A-Z]+:/, '') === (row.symbol || '').replace(/^[A-Z]+:/, '') && ex.transaction_type === txnType) {
                        dupes.push({
                            rowNum: idx + 1,
                            symbol: row.symbol,
                            type: txnType,
                            existingQty: ex.quantity,
                            existingPrice: ex.price,
                            newQty: Math.abs(row.quantity),
                            newPrice: row.price
                        });
                        break;
                    }
                }
            });

            if (dupes.length > 0) {
                var dupMsg = 'Potential duplicate(s) found for ' + txnDate + ':\n\n';
                dupes.forEach(function(d) {
                    dupMsg += 'Row ' + d.rowNum + ': ' + d.symbol + ' ' + d.type +
                        ' — existing: ' + d.existingQty + ' @ ' + d.existingPrice +
                        ', new: ' + d.newQty + ' @ ' + d.newPrice + '\n';
                });
                dupMsg += '\nProceed anyway?';

                if (!confirm(dupMsg)) {
                    document.getElementById('addTxnSaveBtn').disabled = false;
                    return;
                }
            }
        }
    } catch (e) {
        console.warn('Duplicate check failed (proceeding anyway):', e);
    }

    // --- Proceed with Import ---
    showAlert('Importing ' + atRows.length + ' transaction(s)...', 'info', 3000);

    try {
        // Capture wall-clock HH:MM:SS once for the whole save batch — all rows
        // in a single Save click share the same timestamp. Within the batch,
        // id (insertion order) remains the chronological tiebreaker.
        var _atSaveTime = (function() {
            var d = new Date();
            return String(d.getHours()).padStart(2,'0') + ':' +
                   String(d.getMinutes()).padStart(2,'0') + ':' +
                   String(d.getSeconds()).padStart(2,'0');
        })();
        var records = atRows.map(function(row) {
            return {
                investor_id: atSelectedInvestor.id,
                trader_id: row.trader_id || atSelectedInvestor.id,
                broker_id: atSelectedBroker.id,
                security_id: row.security_id,
                security_type: row.security_type || 'EQUITY',
                symbol: row.symbol,
                short_symbol: row.short_symbol || row.symbol,
                company_name: row.company_name || row.symbol,
                exchange: row.exchange || 'NSE',
                product: null,
                transaction_type: row.quantity >= 0 ? 'BUY' : 'SELL',
                transaction_date: document.getElementById('addTxnDate').value,
                transaction_time: _atSaveTime,
                quantity: Math.round(row.quantity),
                lots: row.lots || 0,
                price: atRound(row.price),
                gross_amount: atRound(row.gross_amount),
                brokerage: atRound(row.brokerage || 0),
                stt: atRound(row.stt || 0),
                other_charges: atRound(row.other_charges || 0),
                gst: atRound(row.gst || 0),
                tds: null,
                total_charges: atRound(row.total_charges || 0),
                trader_charges: atRound(row.trader_charges || 0),
                net_amount: atRound(row.net_amount || 0),
                margin_blocked: 0,
                broker_contract_note_no: null,
                broker_trade_id: null,
                tags: (row.tags && row.tags.length > 0) ? row.tags : ['blank'],
                notes: null,
                is_locked: false,
                ignore_for_avg_cost: false,
                dont_display: false
            };
        });

        var headers = wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'});

        // Batch insert (max 10 per batch)
        for (var i = 0; i < records.length; i += 10) {
            var batch = records.slice(i, i + 10);
            var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(batch)
            });
            if (!resp.ok) {
                var errText = await resp.text();
                throw new Error('DB error: ' + resp.status + ' — ' + errText);
            }
        }

        // Remember the date for next modal open
        atLastSavedDate = new Date(atDateState.year, atDateState.month, atDateState.day);

        showAlert('Successfully added ' + records.length + ' transaction(s)', 'success', 3000);
        closeAddTxnModal();

        // Refresh trading module
        if (typeof trRefresh === 'function') trRefresh();

    } catch (e) {
        console.error('Import error:', e);
        showAlert('Error importing: ' + e.message, 'error', 5000);
        document.getElementById('addTxnSaveBtn').disabled = false;
    }
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function atFmtQty(value) {
    if (value === null || value === undefined || isNaN(value) || value === 0) return '';
    var abs = Math.abs(Math.round(value));
    var formatted = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return value < 0 ? '-' + formatted : formatted;
}

function atFmtAmt(value) {
    if (value === null || value === undefined || isNaN(value)) return '0.00';
    // Always show full amount with commas — no display unit division in this modal
    var abs = Math.abs(value);
    var formatted = abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (value < 0) return '(' + formatted + ')';
    return formatted;
}

function atFmtPrice(value) {
    if (value === null || value === undefined || isNaN(value) || value === 0) return '';
    var abs = Math.abs(value);
    // Show up to 2 decimal places, strip trailing zeros
    var formatted = abs.toFixed(2).replace(/\.?0+$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return value < 0 ? '-' + formatted : formatted;
}

// ============================================================================
// Init on script load
// ============================================================================

initAddTxnModule();
