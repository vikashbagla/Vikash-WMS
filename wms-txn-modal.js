// ============================================================================
// WMS SHARED TRANSACTION & EDIT MODALS
// Used by Trading, Reports, and any future module.
// Rule A.1.2: all declarations use var.
//
// ARCHITECTURE:
//   Before opening any modal, the calling module sets wmsTxnCtx:
//     wmsTxnCtx = {
//       transactions: [...],    // array of txn objects (snake_case fields)
//       investors:    [...],    // array of { id, name, short_name }
//       brokers:      [...],    // array of { id, broker_code, short_name }
//       getPrice:  function(shortSymbol) { return price; },
//       getLiveData: function(shortSymbol) { return { lp, ch, chp } or null; },
//       afterChange: function() { ... },  // called after save/delete/flag-toggle
//       filterOverride: null or { investorIds, traderIds, brokerIds, tagNames, tagLogic }
//     };
//   Then call wmsTxnModalOpen(companyKey, investorId).
// ============================================================================

// ---- Context (set by calling module before opening) ----
var wmsTxnCtx = null;

// ---- Modal state ----
var wmsTxnModalKey = null;
var wmsTxnModalInvestorId = null;
var wmsTxnHiddenIds = {};
var wmsTxnShowHidden = false;
var wmsTxnSortColumn = 'date';
var wmsTxnSortDirection = 'asc';
var wmsTxnViewMode = 'list';        // 'list' or 'matching'
var wmsTxnDaysFilter = 0;
var wmsTxnMatchMethod = 'lifo';
var wmsTxnContractFilter = [];
var wmsTxnFnoPricesFetched = false;

// ---- Edit modal state ----
var wmsEditingTxnId = null;
var wmsEditTagCtrl = null;
var _wmsSplitData = null;

// ---- DOM injected flag ----
var _wmsTxnDomReady = false;

// ============================================================================
// HELPERS (investor/broker lookups from context)
// ============================================================================

function wmsTxnInvName(investorId) {
    if (!wmsTxnCtx || !wmsTxnCtx.investors) return investorId || '-';
    var inv = wmsTxnCtx.investors.find(function(i) { return i.id === investorId; });
    return inv ? (inv.short_name || inv.name || investorId) : (investorId || '-');
}

function wmsTxnBrkCode(brokerId) {
    if (!wmsTxnCtx || !wmsTxnCtx.brokers || !brokerId) return '';
    var brk = wmsTxnCtx.brokers.find(function(b) { return b.id === brokerId; });
    return brk ? (brk.broker_code || brk.short_name || '') : '';
}

function wmsTxnInvBrk(txn) {
    var inv = wmsTxnInvName(txn.investor_id);
    var trd = txn.trader_id ? wmsTxnInvName(txn.trader_id) : '';
    var brk = wmsTxnBrkCode(txn.broker_id);
    var label = inv;
    if (trd && trd !== inv) label += ' > ' + trd;
    if (brk) label += ' > ' + brk;
    return label;
}

// ============================================================================
// DOM INJECTION (called once on first use)
// ============================================================================

function _wmsTxnEnsureDom() {
    if (_wmsTxnDomReady) return;
    _wmsTxnDomReady = true;

    // ---- Inject CSS ----
    var style = document.createElement('style');
    style.id = 'wms-txn-modal-styles';
    style.textContent =
        // Transaction modal overlay
        '.wms-txn-overlay { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.45); z-index:1100; justify-content:center; align-items:flex-start; padding:30px 20px; overflow-y:auto; }' +
        '.wms-txn-overlay.show { display:flex; }' +
        '.wms-txn-modal { background:#fff; border-radius:10px; width:100%; max-width:1000px; max-height:85vh; display:flex; flex-direction:column; }' +
        '.wms-txn-header { padding:12px 16px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; }' +
        '.wms-txn-header h3 { margin:0; font-size:14px; color:#2d3748; }' +
        '.wms-txn-header .company-sub { font-size:11px; color:#718096; margin-left:8px; }' +
        '.wms-txn-header-actions { display:flex; align-items:center; gap:8px; }' +
        '.wms-txn-body { padding:12px 16px; overflow-y:auto; flex:1; }' +
        '.wms-txn-body table { width:100%; border-collapse:collapse; }' +
        '.wms-txn-body th { background:#f7fafc; padding:5px 8px; font-size:10px; font-weight:600; text-transform:uppercase; color:#718096; border-bottom:1px solid #e2e8f0; position:sticky; top:0; }' +
        '.wms-txn-body th.sortable { cursor:pointer; user-select:none; }' +
        '.wms-txn-body th.sortable:hover { color:#4a5568; }' +
        '.wms-txn-body td { padding:5px 8px; font-size:12px; border-bottom:1px solid #f0f4f8; }' +
        '.wms-txn-body tr:hover td { background:#f9fafb; }' +
        '.wms-txn-body tr.ignored-row td { opacity:0.5; text-decoration:line-through; }' +
        '.wms-txn-body tr.hidden-row td { opacity:0.5; font-style:italic; }' +
        '.wms-txn-body tr.temp-hidden-row td { opacity:0.35; }' +
        '.wms-txn-body tr.clickable-row { cursor:pointer; }' +
        // Footer
        '.wms-txn-footer { padding:0 16px 12px; flex-shrink:0; }' +
        '.wms-txn-summary-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(0,1fr)); gap:6px; padding-top:8px; border-top:1px solid #e2e8f0; }' +
        '.wms-txn-summary-card { background:#f7fafc; padding:6px 8px; border-radius:6px; border-left:3px solid #667eea; }' +
        '.wms-txn-summary-card.positive { border-left-color:#059669; }' +
        '.wms-txn-summary-card.negative { border-left-color:#dc2626; }' +
        '.wms-txn-summary-card .summary-label { font-size:9px; text-transform:uppercase; color:#718096; font-weight:600; }' +
        '.wms-txn-summary-card .summary-value { font-size:13px; font-weight:700; color:#2d3748; line-height:1.2; }' +
        '.wms-txn-summary-card .summary-sub { font-size:10px; color:#a0aec0; margin-top:2px; }' +
        // View toggle
        '.wms-txn-view-toggle,.wms-txn-match-method { display:inline-flex; border:1px solid #e2e8f0; border-radius:5px; overflow:hidden; }' +
        '.wms-txn-vtog,.wms-txn-mtog { background:none; border:none; padding:3px 10px; font-size:11px; color:#718096; cursor:pointer; border-right:1px solid #e2e8f0; }' +
        '.wms-txn-vtog:last-child,.wms-txn-mtog:last-child { border-right:none; }' +
        '.wms-txn-vtog:hover,.wms-txn-mtog:hover { background:#f7fafc; }' +
        '.wms-txn-vtog.active,.wms-txn-mtog.active { background:#667eea; color:#fff; }' +
        '.wms-txn-days-filter { border:1px solid #e2e8f0; border-radius:5px; padding:3px 6px; font-size:11px; color:#4a5568; background:#fff; cursor:pointer; }' +
        '.wms-txn-btn-toggle-hidden { background:none; border:1px solid #e2e8f0; border-radius:5px; padding:3px 10px; font-size:11px; color:#718096; cursor:pointer; }' +
        '.wms-txn-btn-toggle-hidden:hover { background:#f7fafc; }' +
        '.wms-txn-btn-toggle-hidden.active { background:#edf2f7; color:#4a5568; border-color:#cbd5e0; }' +
        // Matching view
        '.wms-trM-buy-start { border-left:2px solid #d1fae5; }' +
        '.wms-trM-sell-start { border-left:2px solid #fee2e2; }' +
        '#wmsTxnMatchView td.wms-trM-buy-start { border-left:2px solid #d1fae5; }' +
        '#wmsTxnMatchView td.wms-trM-sell-start { border-left:2px solid #fee2e2; }' +
        '.wms-trM-contract-col { min-width:120px; white-space:nowrap; }' +
        '.wms-trM-group-header { cursor:pointer; background:#f7fafc !important; }' +
        '.wms-trM-group-header:hover { background:#edf2f7 !important; }' +
        '.wms-trM-group-header td { font-weight:600; font-size:12px; padding:6px 8px; }' +
        '.wms-trM-collapse-icon { display:inline-block; transition:transform 0.15s; font-size:10px; }' +
        '.wms-trM-group-header.collapsed .wms-trM-collapse-icon { transform:rotate(-90deg); }' +
        '.wms-trM-detail-row.collapsed-row { display:none; }' +
        '.wms-trM-match-open td { font-style:italic; }' +
        '.wms-trM-group-total { font-weight:700; font-size:11px; }' +
        '.wms-trM-pnl-positive { color:#059669; }' +
        '.wms-trM-pnl-negative { color:#dc2626; }' +
        '.wms-trM-unrealised { color:#9ca3af; font-style:italic; }' +
        '.wms-trM-clickable { cursor:pointer; }' +
        '.wms-trM-clickable:hover { background:#f0f4ff !important; }' +
        // Contract filter
        '.wms-trM-cf-wrap { position:relative; display:inline-block; }' +
        '.wms-trM-cf-btn { background:#f3f4f6; border:1px solid #d1d5db; border-radius:4px; padding:4px 10px; font-size:11px; cursor:pointer; white-space:nowrap; }' +
        '.wms-trM-cf-btn:hover { background:#e5e7eb; }' +
        '.wms-trM-cf-dropdown { position:absolute; top:100%; left:0; z-index:100; background:white; border:1px solid #d1d5db; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.15); padding:6px 0; min-width:160px; max-height:240px; overflow-y:auto; }' +
        '.wms-trM-cf-item { display:block; padding:4px 12px; font-size:12px; cursor:pointer; white-space:nowrap; }' +
        '.wms-trM-cf-item:hover { background:#f3f4f6; }' +
        '.wms-trM-cf-item input { margin-right:6px; }' +
        // Txn row hide button
        '.wms-btn-hide-txn { background:none; border:none; cursor:pointer; font-size:12px; padding:2px 4px; opacity:0.5; }' +
        '.wms-btn-hide-txn:hover { opacity:1; }' +
        // Edit modal
        '.wms-edit-overlay { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.35); z-index:1200; justify-content:center; align-items:flex-start; padding:30px 20px; overflow-y:auto; }' +
        '.wms-edit-overlay.show { display:flex; }' +
        '.wms-edit-modal { background:#fff; border-radius:10px; width:100%; max-width:780px; max-height:85vh; display:flex; flex-direction:column; }' +
        '.wms-edit-header { padding:10px 16px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; }' +
        '.wms-edit-header h3 { margin:0; font-size:14px; color:#2d3748; }' +
        '.wms-edit-body { padding:12px 16px; overflow-y:auto; flex:1; }' +
        '.wms-edit-footer { padding:8px 16px; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; }' +
        '.wms-edit-footer-right { display:flex; gap:8px; }' +
        '.wms-edit-section { margin-bottom:10px; }' +
        '.wms-edit-section-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:#a0aec0; margin-bottom:5px; }' +
        '.wms-edit-row { display:grid; gap:6px 10px; margin-bottom:6px; }' +
        '.wms-edit-row.cols-2 { grid-template-columns:1fr 1fr; }' +
        '.wms-edit-row.cols-3 { grid-template-columns:1fr 1fr 1fr; }' +
        '.wms-edit-row.cols-4 { grid-template-columns:1fr 1fr 1fr 1fr; }' +
        '.wms-edit-row .form-group { display:flex; flex-direction:column; min-width:0; }' +
        '.wms-edit-row label { font-size:10px; font-weight:600; color:#718096; margin-bottom:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }' +
        '.wms-edit-row input,.wms-edit-row select,.wms-edit-row textarea { padding:4px 6px; border:1px solid #e2e8f0; border-radius:4px; font-size:12px; min-width:0; }' +
        '.wms-edit-row input:disabled,.wms-edit-row select:disabled { background:#f7fafc; color:#a0aec0; border-color:#edf2f7; }' +
        '.wms-edit-row input.editable-field,.wms-edit-row select.editable-field { background:#fff; border-color:#cbd5e0; }' +
        '.wms-edit-row input.computed-field { background:#f0fdf4; }' +
        '.wms-edit-row input.editable-field.computed-field { background:#f0fdf4; border-color:#cbd5e0; }' +
        '.wms-edit-row input.amt-field { text-align:right; font-variant-numeric:tabular-nums; }' +
        '.wms-edit-form-flags { display:flex; gap:18px; padding:4px 0; }' +
        '.wms-edit-form-flags .flag-label { display:flex; align-items:center; gap:4px; font-size:11px; color:#4a5568; cursor:pointer; }' +
        '.wms-edit-locked-warning { background:#fefce8; border:1px solid #fde68a; border-radius:6px; padding:6px 10px; font-size:11px; color:#92400e; margin-bottom:8px; }' +
        '.wms-edit-section-divider { border:none; border-top:1px solid #edf2f7; margin:6px 0; }' +
        '.wms-edit-security-banner { display:flex; align-items:baseline; gap:8px; padding:6px 0 8px 0; border-bottom:1px solid #edf2f7; margin-bottom:10px; }' +
        '.wms-edit-security-banner .sec-symbol { font-size:15px; font-weight:700; color:#2d3748; }' +
        '.wms-edit-security-banner .sec-company { font-size:12px; color:#718096; }' +
        '.wms-edit-security-banner .sec-type-badge { font-size:9px; font-weight:700; text-transform:uppercase; background:#edf2f7; color:#4a5568; padding:2px 6px; border-radius:3px; }' +
        // Shared button styles (only if not already defined)
        '';
    document.head.appendChild(style);

    // ---- Inject Transaction Modal HTML ----
    var txnDiv = document.createElement('div');
    txnDiv.innerHTML =
        '<div class="wms-txn-overlay" id="wmsTxnModal">' +
            '<div class="wms-txn-modal">' +
                '<div class="wms-txn-header">' +
                    '<div><h3 id="wmsTxnModalTitle">Transactions</h3></div>' +
                    '<div class="wms-txn-header-actions">' +
                        '<div class="wms-trM-cf-wrap" id="wmsTxnContractFilterWrap" style="display:none;"></div>' +
                        '<div class="wms-txn-view-toggle" id="wmsTxnViewToggle">' +
                            '<button class="wms-txn-vtog active" data-view="list">List</button>' +
                            '<button class="wms-txn-vtog" data-view="matching">Matching</button>' +
                        '</div>' +
                        '<select class="wms-txn-days-filter" id="wmsTxnDaysFilter" title="Filter by days">' +
                            '<option value="0">All</option>' +
                            '<option value="7">7 days</option>' +
                            '<option value="15">15 days</option>' +
                            '<option value="30">30 days</option>' +
                            '<option value="60">60 days</option>' +
                            '<option value="90">90 days</option>' +
                            '<option value="180">6 months</option>' +
                            '<option value="365">1 year</option>' +
                        '</select>' +
                        '<div class="wms-txn-match-method" id="wmsTxnMatchMethodWrap" style="display:none;">' +
                            '<button class="wms-txn-mtog active" data-method="lifo">LIFO</button>' +
                            '<button class="wms-txn-mtog" data-method="fifo">FIFO</button>' +
                        '</div>' +
                        '<button class="wms-txn-btn-toggle-hidden" id="wmsTxnToggleHiddenBtn" title="Show/hide temporarily hidden trades">👁 Show All</button>' +
                        '<button class="btn-icon btn-close-modal" id="wmsTxnModalClose" title="Close">✕</button>' +
                    '</div>' +
                '</div>' +
                '<div class="wms-txn-body">' +
                    '<div id="wmsTxnListView">' +
                        '<table>' +
                            '<thead><tr>' +
                                '<th class="sortable" id="wmsTxnThDate">Date <span class="sort-indicator" id="wmsTxnSortDate">▲</span></th>' +
                                '<th>Investor &gt; Trader &gt; Broker</th>' +
                                '<th class="sortable" id="wmsTxnThSymbol">Symbol <span class="sort-indicator" id="wmsTxnSortSymbol"></span></th>' +
                                '<th class="text-right">Qty</th>' +
                                '<th class="text-right">Price</th>' +
                                '<th class="text-right">Value</th>' +
                                '<th class="text-right">Run. Qty</th>' +
                                '<th style="width:60px;text-align:center;">Actions</th>' +
                            '</tr></thead>' +
                            '<tbody id="wmsTxnModalBody"></tbody>' +
                        '</table>' +
                    '</div>' +
                    '<div id="wmsTxnMatchView" style="display:none;">' +
                        '<table>' +
                            '<thead><tr>' +
                                '<th>Inv &gt; Trader &gt; Broker</th>' +
                                '<th class="wms-trM-contract-col">Contract</th>' +
                                '<th class="text-right">Qty</th>' +
                                '<th class="wms-trM-buy-start">Buy Date</th>' +
                                '<th class="text-right">Price</th>' +
                                '<th class="text-right">Amount</th>' +
                                '<th class="wms-trM-sell-start">Sell Date</th>' +
                                '<th class="text-right">Price</th>' +
                                '<th class="text-right">Amount</th>' +
                                '<th class="text-right">P&amp;L</th>' +
                            '</tr></thead>' +
                            '<tbody id="wmsTxnMatchBody"></tbody>' +
                        '</table>' +
                    '</div>' +
                '</div>' +
                '<div class="wms-txn-footer">' +
                    '<div class="wms-txn-summary-cards" id="wmsTxnSummary"></div>' +
                    '<div class="wms-txn-summary-cards" id="wmsTxnMatchSummary"></div>' +
                '</div>' +
            '</div>' +
        '</div>';
    document.body.appendChild(txnDiv.firstElementChild);

    // ---- Inject Edit Modal HTML ----
    var editDiv = document.createElement('div');
    editDiv.innerHTML =
        '<div class="wms-edit-overlay" id="wmsEditModal">' +
            '<div class="wms-edit-modal">' +
                '<div class="wms-edit-header">' +
                    '<div style="display:flex;align-items:baseline;gap:8px;">' +
                        '<h3 id="wmsEditModalTitle">Edit Transaction</h3>' +
                        '<span style="font-size:10px;color:#a0aec0;">All amounts in ₹</span>' +
                    '</div>' +
                    '<button class="btn-icon btn-close-modal" id="wmsEditModalClose" title="Close">✕</button>' +
                '</div>' +
                '<div class="wms-edit-body" id="wmsEditForm">' +
                    '<div class="wms-edit-locked-warning" id="wmsEditLockWarning" style="display:none;">🔒 This transaction is locked. Uncheck the lock below to save changes.</div>' +
                    '<div class="wms-edit-security-banner">' +
                        '<span class="sec-symbol" id="wmsEditBannerSymbol"></span>' +
                        '<span class="sec-company" id="wmsEditBannerCompany"></span>' +
                        '<span class="sec-type-badge" id="wmsEditBannerType"></span>' +
                    '</div>' +
                    // Parties
                    '<div class="wms-edit-section"><div class="wms-edit-section-label">Parties</div>' +
                        '<div class="wms-edit-row cols-4">' +
                            '<div class="form-group"><label>Investor</label><input type="text" id="wmsEditInvestor" disabled></div>' +
                            '<div class="form-group"><label>Broker</label><input type="text" id="wmsEditBroker" disabled></div>' +
                            '<div class="form-group"><label>Contract Note No</label><input type="text" id="wmsEditCnNo" class="editable-field"></div>' +
                            '<div class="form-group"><label>Trader</label><select id="wmsEditTrader" class="editable-field"></select></div>' +
                        '</div>' +
                    '</div>' +
                    '<hr class="wms-edit-section-divider">' +
                    // Trade Details
                    '<div class="wms-edit-section"><div class="wms-edit-section-label">Trade Details</div>' +
                        '<div class="wms-edit-row cols-4">' +
                            '<div class="form-group"><label>Date</label><input type="text" id="wmsEditDate" disabled style="text-align:right;"></div>' +
                            '<div class="form-group"><label>Type</label><input type="text" id="wmsEditType" disabled></div>' +
                            '<div class="form-group"><label>Exchange</label><input type="text" id="wmsEditExchange" disabled></div>' +
                            '<div class="form-group"><label>Product</label><input type="text" id="wmsEditProduct" disabled></div>' +
                        '</div>' +
                        '<div class="wms-edit-row cols-4">' +
                            '<div class="form-group"><label>Lots</label><input type="text" id="wmsEditLots" disabled class="amt-field"></div>' +
                            '<div class="form-group"><label>Quantity</label><input type="text" id="wmsEditQty" class="editable-field amt-field"></div>' +
                            '<div class="form-group"><label>Price</label><input type="text" id="wmsEditPrice" class="editable-field amt-field"></div>' +
                            '<div class="form-group"><label>Gross Amount</label><input type="text" id="wmsEditGross" class="editable-field computed-field amt-field"></div>' +
                        '</div>' +
                    '</div>' +
                    '<hr class="wms-edit-section-divider">' +
                    // Charges
                    '<div class="wms-edit-section"><div class="wms-edit-section-label">Charges</div>' +
                        '<div class="wms-edit-row cols-3">' +
                            '<div class="form-group"><label>Brokerage</label><input type="text" id="wmsEditBrokerage" class="editable-field amt-field"></div>' +
                            '<div class="form-group"><label>STT</label><input type="text" id="wmsEditStt" class="editable-field amt-field"></div>' +
                            '<div class="form-group"><label>Other Charges</label><input type="text" id="wmsEditOther" class="editable-field amt-field"></div>' +
                        '</div>' +
                        '<div class="wms-edit-row cols-3">' +
                            '<div class="form-group"><label>GST</label><input type="text" id="wmsEditGst" class="editable-field amt-field"></div>' +
                            '<div class="form-group"><label>Total Charges</label><input type="text" id="wmsEditTotalCharges" class="editable-field computed-field amt-field"></div>' +
                            '<div class="form-group"><label>Net Amount</label><input type="text" id="wmsEditNetAmount" class="editable-field computed-field amt-field"></div>' +
                        '</div>' +
                        '<div class="wms-edit-row cols-3">' +
                            '<div class="form-group"><label>Trader Charges</label><input type="text" id="wmsEditTraderCharges" class="editable-field amt-field"></div>' +
                            '<div class="form-group"><label>TDS</label><input type="text" id="wmsEditTds" class="editable-field amt-field"></div>' +
                            '<div class="form-group"><label>Margin Blocked</label><input type="text" id="wmsEditMargin" class="editable-field amt-field"></div>' +
                        '</div>' +
                    '</div>' +
                    '<hr class="wms-edit-section-divider">' +
                    // Tags & Notes
                    '<div class="wms-edit-section"><div class="wms-edit-section-label">Tags & Notes</div>' +
                        '<div class="wms-edit-row cols-2">' +
                            '<div class="form-group" style="position:relative;"><label>Tags</label><input type="text" id="wmsEditTagsInput" class="editable-field" placeholder="Type tag + Enter or comma..." autocomplete="off"><div class="addTxn-tag-pills" id="wmsEditTagPills" style="margin-top:3px;"></div><div class="addTxn-tag-dd" id="wmsEditTagDd"></div></div>' +
                            '<div class="form-group"><label>Notes</label><input type="text" id="wmsEditNotes" class="editable-field" placeholder="Optional notes..."></div>' +
                        '</div>' +
                    '</div>' +
                    '<hr class="wms-edit-section-divider">' +
                    // Flags
                    '<div class="wms-edit-section">' +
                        '<div class="wms-edit-form-flags">' +
                            '<label class="flag-label"><input type="checkbox" id="wmsEditLocked" disabled> Locked</label>' +
                            '<label class="flag-label"><input type="checkbox" id="wmsEditDontDisplay"> Don\'t Display</label>' +
                            '<label class="flag-label"><input type="checkbox" id="wmsEditIgnoreAvg"> Ignore for Avg Cost</label>' +
                        '</div>' +
                    '</div>' +
                    '<hr class="wms-edit-section-divider">' +
                    // Split
                    '<div class="wms-edit-section" id="wmsSplitSection" style="display:none;">' +
                        '<div class="wms-edit-section-label" style="color:#7c3aed;">Split Transaction</div>' +
                        '<div style="font-size:11px;color:#718096;margin-bottom:8px;">Enter the quantity to split off into a new transaction. Charges are allocated proportionally.</div>' +
                        '<div class="wms-edit-row cols-3">' +
                            '<div class="form-group"><label>Split Qty (absolute)</label><input type="text" id="wmsSplitQty" class="amt-field" placeholder="e.g. 50"></div>' +
                            '<div class="form-group"><label>Assign Trader</label><select id="wmsSplitTrader"></select></div>' +
                            '<div class="form-group" style="justify-content:flex-end;"><button class="btn-secondary" id="wmsSplitPreviewBtn" style="padding:5px 14px;font-size:11px;">Preview</button></div>' +
                        '</div>' +
                        '<div id="wmsSplitPreview" style="display:none;margin-top:8px;">' +
                            '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
                                '<thead><tr style="background:#f5f3ff;border-bottom:1px solid #e2e8f0;">' +
                                    '<th style="padding:4px 6px;text-align:left;font-weight:600;color:#7c3aed;">Row</th>' +
                                    '<th style="padding:4px 6px;text-align:left;font-weight:600;color:#7c3aed;">Trader</th>' +
                                    '<th style="padding:4px 6px;text-align:right;font-weight:600;color:#7c3aed;">Qty</th>' +
                                    '<th style="padding:4px 6px;text-align:right;font-weight:600;color:#7c3aed;">Price</th>' +
                                    '<th style="padding:4px 6px;text-align:right;font-weight:600;color:#7c3aed;">Gross</th>' +
                                    '<th style="padding:4px 6px;text-align:right;font-weight:600;color:#7c3aed;">Charges</th>' +
                                    '<th style="padding:4px 6px;text-align:right;font-weight:600;color:#7c3aed;">Trader Chg</th>' +
                                    '<th style="padding:4px 6px;text-align:right;font-weight:600;color:#7c3aed;">Net</th>' +
                                '</tr></thead>' +
                                '<tbody id="wmsSplitPreviewBody"></tbody>' +
                            '</table>' +
                            '<div style="margin-top:8px;text-align:right;">' +
                                '<button class="btn-primary" id="wmsSplitConfirmBtn" style="background:#7c3aed;border-color:#7c3aed;padding:5px 14px;font-size:11px;">Confirm Split</button>' +
                            '</div>' +
                        '</div>' +
                        '<div id="wmsSplitStatus" style="font-size:11px;margin-top:4px;"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="wms-edit-footer">' +
                    '<button class="btn-danger" id="wmsEditDeleteBtn">Delete</button>' +
                    '<div class="wms-edit-footer-right">' +
                        '<button class="btn-secondary" id="wmsSplitBtn" style="background:#f5f3ff;color:#7c3aed;border-color:#c4b5fd;">Split</button>' +
                        '<button class="btn-secondary" id="wmsEditCancelBtn">Cancel</button>' +
                        '<button class="btn-primary" id="wmsEditSaveBtn">Save Changes</button>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
    document.body.appendChild(editDiv.firstElementChild);

    // ---- Wire static listeners (once) ----
    _wmsTxnAttachStaticListeners();
}

// ============================================================================
// STATIC LISTENERS (wired once after DOM injection)
// ============================================================================

function _wmsTxnAttachStaticListeners() {
    // Txn modal close
    document.getElementById('wmsTxnModalClose').addEventListener('click', wmsTxnModalClose);
    document.getElementById('wmsTxnModal').addEventListener('click', function(e) {
        if (e.target === this) wmsTxnModalClose();
    });

    // Sort headers
    document.getElementById('wmsTxnThDate').addEventListener('click', function() { wmsTxnSort('date'); });
    document.getElementById('wmsTxnThSymbol').addEventListener('click', function() { wmsTxnSort('symbol'); });

    // Toggle hidden
    document.getElementById('wmsTxnToggleHiddenBtn').addEventListener('click', wmsTxnToggleShowHidden);

    // View toggle (List / Matching)
    document.querySelectorAll('.wms-txn-vtog').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.wms-txn-vtog').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            wmsTxnViewMode = btn.dataset.view;
            wmsTxnSwitchView();
        });
    });

    // Days filter
    document.getElementById('wmsTxnDaysFilter').addEventListener('change', function() {
        wmsTxnDaysFilter = parseInt(this.value) || 0;
        wmsTxnRefreshCurrentView();
    });

    // FIFO/LIFO toggle
    document.querySelectorAll('.wms-txn-mtog').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.wms-txn-mtog').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            wmsTxnMatchMethod = btn.dataset.method;
            wmsTxnRenderMatchingView();
        });
    });

    // Edit modal close/save
    document.getElementById('wmsEditModalClose').addEventListener('click', wmsEditModalClose);
    document.getElementById('wmsEditCancelBtn').addEventListener('click', wmsEditModalClose);
    document.getElementById('wmsEditSaveBtn').addEventListener('click', wmsEditSave);
    document.getElementById('wmsEditDeleteBtn').addEventListener('click', function() {
        if (!wmsEditingTxnId) return;
        var txnId = wmsEditingTxnId;
        wmsEditModalClose();
        wmsDeleteTransaction(txnId);
    });
    document.getElementById('wmsEditModal').addEventListener('click', function(e) {
        if (e.target === this) wmsEditModalClose();
    });

    // Split
    document.getElementById('wmsSplitBtn').addEventListener('click', wmsToggleSplitPanel);
    document.getElementById('wmsSplitPreviewBtn').addEventListener('click', wmsPreviewSplit);
    document.getElementById('wmsSplitConfirmBtn').addEventListener('click', wmsExecuteSplit);

    // Trader change → recalc
    document.getElementById('wmsEditTrader').addEventListener('change', wmsRecalcTraderCharges);

    // Qty/Price → recalc
    document.getElementById('wmsEditQty').addEventListener('input', wmsRecalcEditAmounts);
    document.getElementById('wmsEditPrice').addEventListener('input', wmsRecalcEditAmounts);

    // Amt field focus/blur formatting
    document.querySelectorAll('.wms-edit-body .amt-field').forEach(function(el) {
        el.addEventListener('focus', function() {
            var raw = parseFloat((el.value || '0').replace(/,/g, '')) || 0;
            el.value = raw || '';
        });
        el.addEventListener('blur', function() {
            var raw = parseFloat((el.value || '0').replace(/,/g, '')) || 0;
            if (el.id === 'wmsEditQty') {
                el.value = wmsEditFmtInt(raw);
            } else {
                el.value = wmsEditFmt(raw);
            }
        });
    });

    // ESC key
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (document.getElementById('wmsEditModal').classList.contains('show')) {
                wmsEditModalClose();
            } else if (document.getElementById('wmsTxnModal').classList.contains('show')) {
                wmsTxnModalClose();
            }
        }
    });
}

// ============================================================================
// FORMAT HELPERS
// ============================================================================

function wmsEditFmt(val) {
    var n = parseFloat(val) || 0;
    return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function wmsEditFmtInt(val) {
    var n = parseInt(val) || 0;
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function wmsEditParse(el) {
    return parseFloat((el.value || '0').replace(/,/g, '')) || 0;
}

// ============================================================================
// TRANSACTION MODAL: OPEN / CLOSE
// ============================================================================

function wmsTxnModalOpen(companyKey, investorId) {
    _wmsTxnEnsureDom();

    wmsTxnModalKey = companyKey;
    wmsTxnModalInvestorId = investorId || null;
    wmsTxnHiddenIds = {};
    wmsTxnShowHidden = false;
    wmsTxnFnoPricesFetched = false;

    var txns = wmsTxnGetModalTxns();

    // Resolve title
    var companyName = '';
    var titleExtra = '';
    if (companyKey === '__ALL__') {
        companyName = 'All Transactions';
    } else {
        for (var i = 0; i < txns.length; i++) {
            if (txns[i].company_name && txns[i].security_type !== 'NFO') {
                companyName = txns[i].company_name; break;
            }
        }
        if (!companyName && wmsRefData.securitiesCmReady) {
            for (var j = 0; j < wmsRefData.securitiesCm.length; j++) {
                var s = wmsRefData.securitiesCm[j];
                if (s.symbol === companyKey || s.nse_symbol === companyKey || s.bse_symbol === companyKey) {
                    companyName = s.company_name; break;
                }
            }
        }
        companyName = companyName || companyKey;
        if (investorId) {
            titleExtra = ' <span style="font-size:11px;color:#667eea;">(' + wmsTxnInvName(investorId) + ')</span>';
        }
    }
    document.getElementById('wmsTxnModalTitle').innerHTML = wmsEsc(companyName) +
        (companyKey !== '__ALL__' ? '<span class="company-sub">' + wmsEsc(companyKey) + '</span>' : '') + titleExtra;

    // Reset state
    wmsTxnSortColumn = 'date';
    wmsTxnSortDirection = 'asc';
    wmsTxnViewMode = 'list';
    wmsTxnDaysFilter = 0;
    wmsTxnMatchMethod = 'lifo';
    wmsTxnContractFilter = [];

    // Update toggle button
    var toggleBtn = document.getElementById('wmsTxnToggleHiddenBtn');
    toggleBtn.classList.remove('active');
    toggleBtn.textContent = '👁 Show All';

    // Reset controls UI
    document.querySelectorAll('.wms-txn-vtog').forEach(function(b) { b.classList.toggle('active', b.dataset.view === 'list'); });
    document.getElementById('wmsTxnDaysFilter').value = '0';
    document.querySelectorAll('.wms-txn-mtog').forEach(function(b) { b.classList.toggle('active', b.dataset.method === 'lifo'); });
    document.getElementById('wmsTxnMatchMethodWrap').style.display = 'none';
    document.getElementById('wmsTxnToggleHiddenBtn').style.display = '';

    // Show list, hide matching
    document.getElementById('wmsTxnListView').style.display = '';
    document.getElementById('wmsTxnMatchView').style.display = 'none';
    var listSummary = document.getElementById('wmsTxnSummary');
    var matchSummary = document.getElementById('wmsTxnMatchSummary');
    if (listSummary) listSummary.style.display = '';
    if (matchSummary) matchSummary.style.display = 'none';

    // Render
    wmsTxnRenderTable(txns);

    // Show modal
    document.getElementById('wmsTxnModal').classList.add('show');
}

function wmsTxnModalClose() {
    document.getElementById('wmsTxnModal').classList.remove('show');
    wmsTxnModalKey = null;
    wmsTxnModalInvestorId = null;
    wmsTxnHiddenIds = {};
    wmsTxnShowHidden = false;
    wmsTxnViewMode = 'list';
    wmsTxnDaysFilter = 0;
    wmsTxnMatchMethod = 'lifo';
    wmsTxnContractFilter = [];
}

// ============================================================================
// GET FILTERED TRANSACTIONS FOR MODAL
// ============================================================================

function wmsTxnGetModalTxns() {
    if (!wmsTxnCtx) return [];
    var shortSymbol = wmsTxnModalKey;
    var txns;
    if (shortSymbol === '__ALL__') {
        txns = wmsTxnCtx.transactions.slice();
    } else {
        txns = wmsTxnCtx.transactions.filter(function(t) {
            return (t.short_symbol || t.symbol) === shortSymbol;
        });
    }
    // Investor filter
    if (wmsTxnModalInvestorId) {
        txns = txns.filter(function(t) { return t.investor_id === wmsTxnModalInvestorId; });
    }
    // Apply filter override from context
    var _ov = wmsTxnCtx.filterOverride || null;
    if (_ov) {
        if (_ov.investorIds && _ov.investorIds.length > 0) {
            txns = txns.filter(function(t) { return _ov.investorIds.indexOf(t.investor_id) >= 0; });
        }
        if (_ov.traderIds && _ov.traderIds.length > 0) {
            txns = txns.filter(function(t) { var tid = t.trader_id || t.investor_id; return tid && _ov.traderIds.indexOf(tid) >= 0; });
        }
        if (_ov.brokerIds && _ov.brokerIds.length > 0) {
            txns = txns.filter(function(t) { return t.broker_id && _ov.brokerIds.indexOf(t.broker_id) >= 0; });
        }
        if (_ov.tagNames && _ov.tagNames.length > 0) {
            txns = txns.filter(function(t) {
                return wmsMatchTagsFilter(t.tags, _ov.tagNames, _ov.tagLogic || 'OR');
            });
        }
    }
    // Days filter
    if (wmsTxnDaysFilter > 0) {
        var cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - wmsTxnDaysFilter);
        txns = txns.filter(function(t) {
            return new Date(t.transaction_date) >= cutoff;
        });
    }
    return txns;
}

// ============================================================================
// RENDER TRANSACTION LIST TABLE
// ============================================================================

function wmsTxnRenderTable(txns) {
    if (!txns) txns = wmsTxnGetModalTxns();

    // Build expiry filter for list view
    if (wmsTxnViewMode === 'list') {
        var allExpiries = {};
        var monthIdx = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
        txns.forEach(function(t) {
            var expiry = _wmsTxnGetExpiryLabel(wmsFormatContract(t));
            allExpiries[expiry] = true;
        });
        var expiryKeys = Object.keys(allExpiries);
        expiryKeys.sort(function(a, b) {
            if (a === 'Equity' && b === 'Equity') return 0;
            if (a === 'Equity') return 1;
            if (b === 'Equity') return -1;
            var pa = a.split(' '), pb = b.split(' ');
            var tA = (monthIdx[pa[0]] !== undefined) ? new Date(2000 + parseInt(pa[1], 10), monthIdx[pa[0]], 1).getTime() : -1;
            var tB = (monthIdx[pb[0]] !== undefined) ? new Date(2000 + parseInt(pb[1], 10), monthIdx[pb[0]], 1).getTime() : -1;
            return tB - tA;
        });
        _wmsTxnBuildContractFilter(expiryKeys);
    }

    // Running qty (chronological)
    var chronoTxns = txns.slice().sort(function(a, b) {
        return new Date(a.transaction_date) - new Date(b.transaction_date);
    });
    var runningQtyMap = {};
    var runSum = 0;
    chronoTxns.forEach(function(t) {
        if (!wmsIsQtyExcluded(t.transaction_type)) {
            runSum += (t.quantity || 0);
        }
        runningQtyMap[t.id] = runSum;
    });

    // Apply expiry filter
    if (wmsTxnContractFilter.length > 0) {
        txns = txns.filter(function(t) {
            var expiry = _wmsTxnGetExpiryLabel(wmsFormatContract(t));
            return wmsTxnContractFilter.indexOf(expiry) >= 0;
        });
    }

    // Sort
    var displayTxns = txns.slice();
    displayTxns.sort(function(a, b) {
        if (wmsTxnSortColumn === 'symbol') {
            var sA = (a.symbol || '').toLowerCase(), sB = (b.symbol || '').toLowerCase();
            return wmsTxnSortDirection === 'asc' ? sA.localeCompare(sB) : sB.localeCompare(sA);
        }
        var dA = new Date(a.transaction_date), dB = new Date(b.transaction_date);
        return wmsTxnSortDirection === 'asc' ? dA - dB : dB - dA;
    });

    var tbody = document.getElementById('wmsTxnModalBody');
    if (displayTxns.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:#9ca3af;">No transactions found</td></tr>';
    } else {
        tbody.innerHTML = displayTxns.map(function(txn) {
            var invBrk = wmsTxnInvBrk(txn);
            var isIncome = WMS_INCOME_TYPES.indexOf(txn.transaction_type) >= 0;
            var typeClass = (txn.transaction_type === 'BUY' || txn.transaction_type === 'RIGHTS_ENTITLEMENT' || txn.transaction_type === 'BONUS' || txn.transaction_type === 'SPLIT') ? 'positive' : (txn.transaction_type === 'SELL' ? 'negative' : (txn.transaction_type === 'RIGHTS_PAYMENT' ? 'neutral' : ''));
            var qty = txn.quantity || 0;
            var _dispNet = txn.display_net_amount !== undefined ? txn.display_net_amount : txn.net_amount;
            var val = _dispNet || txn.gross_amount || 0;
            var displayPrice = (qty !== 0) ? Math.abs(val / qty) : 0;
            var runQty = runningQtyMap[txn.id] || 0;

            var rowClass = 'clickable-row';
            if (txn.ignore_for_avg_cost) rowClass += ' ignored-row';
            else if (txn.dont_display) rowClass += ' hidden-row';

            var isTempHidden = wmsTxnHiddenIds[txn.id];
            if (isTempHidden && !wmsTxnShowHidden) return '';
            if (isTempHidden) rowClass += ' temp-hidden-row';

            var menuId = 'wms-txm-' + txn.id.substring(0, 8);

            return '<tr class="' + rowClass + '" data-txn-id="' + txn.id + '">' +
                '<td>' + formatDate(txn.transaction_date) + '</td>' +
                '<td>' + invBrk + '</td>' +
                '<td><span class="' + typeClass + '" style="font-weight:600;">' + txn.transaction_type + '</span> ' + wmsStripExchangePrefix(txn) + '</td>' +
                '<td class="text-right">' + (qty !== 0 ? formatQuantity(Math.abs(qty)) : '-') + '</td>' +
                '<td class="text-right">' + (qty !== 0 ? formatPrice(displayPrice, false) : '-') + '</td>' +
                '<td class="text-right ' + getAmountClass(val) + '">' + formatAmount(val) + '</td>' +
                '<td class="text-right">' + formatQuantity(runQty) + '</td>' +
                '<td class="action-cell" style="position:relative;">' +
                    '<button class="wms-btn-hide-txn" data-txn-id="' + txn.id + '" title="Toggle visibility">👁</button>' +
                    '<button class="btn-action wms-txn-action-btn" data-txn-id="' + txn.id + '" title="Actions">⋮</button>' +
                    '<div class="action-menu" id="' + menuId + '">' +
                        '<button class="action-menu-item" data-txn-action="edit" data-txn-id="' + txn.id + '">✏️ Edit</button>' +
                        '<button class="action-menu-item" data-txn-action="toggle-display" data-txn-id="' + txn.id + '">' +
                            (txn.dont_display ? '👁 Show in Display' : '👁 Hide from Display') + '</button>' +
                        '<button class="action-menu-item" data-txn-action="toggle-ignore" data-txn-id="' + txn.id + '">' +
                            (txn.ignore_for_avg_cost ? '✅ Include in Avg Cost' : '🚫 Ignore for Avg Cost') + '</button>' +
                        '<button class="action-menu-item danger" data-txn-action="delete" data-txn-id="' + txn.id + '">🗑️ Delete</button>' +
                    '</div>' +
                '</td>' +
            '</tr>';
        }).join('');
    }

    // Summary
    wmsTxnRenderListSummary(txns);

    // Sort indicators
    document.getElementById('wmsTxnSortDate').textContent = wmsTxnSortColumn === 'date' ? (wmsTxnSortDirection === 'asc' ? '▲' : '▼') : '';
    document.getElementById('wmsTxnSortSymbol').textContent = wmsTxnSortColumn === 'symbol' ? (wmsTxnSortDirection === 'asc' ? '▲' : '▼') : '';

    // Attach row listeners
    _wmsTxnAttachRowListeners();
}

function _wmsTxnAttachRowListeners() {
    // Clickable rows → edit
    document.querySelectorAll('#wmsTxnModalBody .clickable-row').forEach(function(row) {
        row.addEventListener('click', function(e) {
            if (e.target.closest('.action-cell')) return;
            wmsEditModalOpen(row.dataset.txnId);
        });
    });

    // Temp hide buttons
    document.querySelectorAll('#wmsTxnModalBody .wms-btn-hide-txn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            wmsTxnToggleTempHide(btn.dataset.txnId);
        });
    });

    // Transaction action buttons
    document.querySelectorAll('#wmsTxnModalBody .wms-txn-action-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var menuId = 'wms-txm-' + btn.dataset.txnId.substring(0, 8);
            var menu = document.getElementById(menuId);
            if (!menu) return;
            var wasOpen = menu.classList.contains('show');
            document.querySelectorAll('#wmsTxnModalBody .action-menu.show').forEach(function(m) { m.classList.remove('show'); });
            if (!wasOpen) menu.classList.add('show');
        });
    });

    // Action menu items
    document.querySelectorAll('#wmsTxnModalBody .action-menu-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            document.querySelectorAll('#wmsTxnModalBody .action-menu.show').forEach(function(m) { m.classList.remove('show'); });
            var action = item.dataset.txnAction;
            var txnId = item.dataset.txnId;
            if (action === 'edit') wmsEditModalOpen(txnId);
            else if (action === 'toggle-display') wmsToggleTxnFlag(txnId, 'dont_display');
            else if (action === 'toggle-ignore') wmsToggleTxnFlag(txnId, 'ignore_for_avg_cost');
            else if (action === 'delete') wmsDeleteTransaction(txnId);
        });
    });
}

// ============================================================================
// LIST SUMMARY
// ============================================================================

function wmsTxnRenderListSummary(txns) {
    var container = document.getElementById('wmsTxnSummary');
    if (!container) return;

    var calc = wmsCalcAvgCost(txns);
    var netQty = calc.netQuantity;
    var totalCost = netQty === 0 ? 0 : calc.totalCost;
    var avgCost = netQty === 0 ? 0 : calc.avgCost;

    var currentPrice = wmsTxnCtx && wmsTxnCtx.getPrice ? wmsTxnCtx.getPrice(wmsTxnModalKey) : 0;
    var currentValue = netQty * currentPrice;
    var pl = currentValue - totalCost;
    var plPct = totalCost !== 0 ? (pl / Math.abs(totalCost)) * 100 : 0;

    container.innerHTML =
        '<div class="wms-txn-summary-card">' +
            '<div class="summary-label">Net Quantity</div>' +
            '<div class="summary-value">' + formatQuantity(netQty) + '</div>' +
        '</div>' +
        '<div class="wms-txn-summary-card">' +
            '<div class="summary-label">Invested Amount</div>' +
            '<div class="summary-value">' + formatAmount(totalCost) + '</div>' +
            '<div class="summary-sub">Avg Cost: ' + formatPrice(avgCost, false) + '</div>' +
        '</div>' +
        '<div class="wms-txn-summary-card ' + getAmountClass(pl) + '">' +
            '<div class="summary-label">Current Value</div>' +
            '<div class="summary-value">' + formatAmount(currentValue) + '</div>' +
            '<div class="summary-sub ' + getAmountClass(pl) + '">P&L: ' + formatAmount(pl) + ' (' + formatPercent(plPct) + ')</div>' +
        '</div>';
}

// ============================================================================
// SORT / TOGGLE / REFRESH
// ============================================================================

function wmsTxnSort(column) {
    if (wmsTxnSortColumn === column) {
        wmsTxnSortDirection = wmsTxnSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        wmsTxnSortColumn = column;
        wmsTxnSortDirection = 'asc';
    }
    wmsTxnRenderTable();
}

function wmsTxnToggleShowHidden() {
    wmsTxnShowHidden = !wmsTxnShowHidden;
    var btn = document.getElementById('wmsTxnToggleHiddenBtn');
    btn.classList.toggle('active', wmsTxnShowHidden);
    btn.textContent = wmsTxnShowHidden ? '👁 Hide Filtered' : '👁 Show All';
    wmsTxnRenderTable();
}

function wmsTxnToggleTempHide(txnId) {
    if (wmsTxnHiddenIds[txnId]) {
        delete wmsTxnHiddenIds[txnId];
    } else {
        wmsTxnHiddenIds[txnId] = true;
    }
    wmsTxnRenderTable();
}

function wmsTxnRefreshCurrentView() {
    if (wmsTxnViewMode === 'matching') {
        wmsTxnRenderMatchingView();
    } else {
        wmsTxnRenderTable();
    }
}

function wmsTxnSwitchView() {
    var listView = document.getElementById('wmsTxnListView');
    var matchView = document.getElementById('wmsTxnMatchView');
    var matchMethodWrap = document.getElementById('wmsTxnMatchMethodWrap');
    var hiddenBtn = document.getElementById('wmsTxnToggleHiddenBtn');
    var listSummary = document.getElementById('wmsTxnSummary');
    var matchSummary = document.getElementById('wmsTxnMatchSummary');

    if (wmsTxnViewMode === 'matching') {
        listView.style.display = 'none';
        matchView.style.display = '';
        matchMethodWrap.style.display = '';
        hiddenBtn.style.display = 'none';
        if (listSummary) listSummary.style.display = 'none';
        if (matchSummary) matchSummary.style.display = '';
        wmsTxnRenderMatchingView();
    } else {
        listView.style.display = '';
        matchView.style.display = 'none';
        matchMethodWrap.style.display = 'none';
        hiddenBtn.style.display = '';
        if (listSummary) listSummary.style.display = '';
        if (matchSummary) matchSummary.style.display = 'none';
        wmsTxnRenderTable();
    }
}

// ============================================================================
// MATCHING VIEW
// ============================================================================

function wmsTxnRenderMatchingView() {
    var tbody = document.getElementById('wmsTxnMatchBody');
    if (!tbody) return;

    var txns = wmsTxnGetModalTxns();

    // Group by investor + trader + broker + full symbol
    var groups = {};
    txns.forEach(function(t) {
        var tt = t.transaction_type;
        if (tt !== 'BUY' && tt !== 'SELL' && tt !== 'BONUS' && tt !== 'SPLIT' &&
            tt !== 'RIGHTS_ENTITLEMENT' && tt !== 'RIGHTS_PAYMENT' &&
            tt !== 'CAPITAL_REDUCTION' && tt !== 'HISTORICAL_PL') return;
        var invId = t.investor_id || '';
        var trdId = t.trader_id || t.investor_id || '';
        var brkId = t.broker_id || '';
        var fullSym = (t.symbol || t.short_symbol || '').replace(/^[A-Z]+:/, '');
        var key = invId + '|' + trdId + '|' + brkId + '|' + fullSym;
        if (!groups[key]) {
            groups[key] = {
                investorId: t.investor_id, traderId: t.trader_id, brokerId: t.broker_id,
                fullSymbol: fullSym, shortSymbol: t.short_symbol || t.symbol || '',
                contractLabel: wmsFormatContract(t), txns: []
            };
        }
        groups[key].txns.push(t);
    });

    // Expiry filter
    var allExpiries = {};
    Object.keys(groups).forEach(function(k) {
        var expiry = _wmsTxnGetExpiryLabel(groups[k].contractLabel);
        allExpiries[expiry] = true;
    });
    var expiryKeys = Object.keys(allExpiries);
    var monthIdx = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    expiryKeys.sort(function(a, b) {
        if (a === 'Equity') return 1; if (b === 'Equity') return -1;
        var pa = a.split(' '), pb = b.split(' ');
        var tA = (monthIdx[pa[0]] !== undefined) ? new Date(2000 + parseInt(pa[1], 10), monthIdx[pa[0]], 1).getTime() : -1;
        var tB = (monthIdx[pb[0]] !== undefined) ? new Date(2000 + parseInt(pb[1], 10), monthIdx[pb[0]], 1).getTime() : -1;
        return tB - tA;
    });
    _wmsTxnBuildContractFilter(expiryKeys);

    var groupResults = [];
    var matchMethod = wmsTxnMatchMethod === 'lifo' ? 'lifo' : 'fifo';

    Object.keys(groups).sort().forEach(function(key) {
        var g = groups[key];
        if (wmsTxnContractFilter.length > 0 && wmsTxnContractFilter.indexOf(_wmsTxnGetExpiryLabel(g.contractLabel)) < 0) return;

        var sorted = g.txns.slice().sort(function(a, b) {
            var da = a.transaction_date || '', db = b.transaction_date || '';
            if (da !== db) return da < db ? -1 : 1;
            return (a.id || 0) - (b.id || 0);
        });

        var result = matchMethod === 'lifo' ? wmsCalcLifoCost(sorted) : wmsCalcFifoCost(sorted);

        // CMP
        var contractCache = wmsLivePrices ? wmsLivePrices[g.fullSymbol] : null;
        var cmp = contractCache ? contractCache.lp : (wmsTxnCtx && wmsTxnCtx.getPrice ? wmsTxnCtx.getPrice(g.shortSymbol) : 0);

        var matchedRows = [];
        result.gains.forEach(function(gain) {
            matchedRows.push({
                type: 'matched', isShort: gain.sellDate < gain.buyDate,
                qty: gain.qty,
                buyDate: gain.buyDate, buyAvg: gain.buyCostPerUnit, buyAmount: gain.buyCost,
                sellDate: gain.sellDate, sellAvg: gain.sellProceedsPerUnit, sellAmount: gain.sellProceeds,
                pnl: gain.gain, buyTxnId: gain.buyTxnId, sellTxnId: gain.sellTxnId
            });
        });

        Object.keys(result.holdings).forEach(function(hk) {
            result.holdings[hk].lots.forEach(function(lot) {
                if (!lot.qty) return;
                var lotIsShort = lot.qty < 0;
                var absQty = Math.abs(lot.qty);
                var ppu = lot.costPerUnit;
                var row = { type: 'open', isShort: lotIsShort, qty: absQty, pnl: 0, openerTxnId: lot.txnId };
                if (lotIsShort) {
                    row.buyDate = null; row.buyAvg = 0; row.buyAmount = 0;
                    row.sellDate = lot.date; row.sellAvg = ppu; row.sellAmount = absQty * ppu;
                } else {
                    row.buyDate = lot.date; row.buyAvg = ppu; row.buyAmount = absQty * ppu;
                    row.sellDate = null; row.sellAvg = 0; row.sellAmount = 0;
                }
                if (cmp > 0) {
                    row.cmp = cmp;
                    var openCostR = lotIsShort ? row.sellAmount : row.buyAmount;
                    row.unrealisedPnl = lotIsShort ? (openCostR - absQty * cmp) : (absQty * cmp - openCostR);
                }
                matchedRows.push(row);
            });
        });

        if (matchedRows.length === 0) return;

        var isShort = false;
        for (var ri = 0; ri < matchedRows.length; ri++) {
            if (matchedRows[ri].type === 'open') { isShort = matchedRows[ri].isShort; break; }
        }

        matchedRows.sort(function(a, b) {
            var dateA = isShort ? (a.sellDate || '9999') : (a.buyDate || '9999');
            var dateB = isShort ? (b.sellDate || '9999') : (b.buyDate || '9999');
            return new Date(dateA) - new Date(dateB);
        });

        var totalQty = 0, totalBuyAmt = 0, totalSellAmt = 0, totalPnl = 0, totalOpenQty = 0, totalUnrealisedPnl = 0;
        matchedRows.forEach(function(r) {
            if (r.type === 'matched') { totalQty += r.qty; totalBuyAmt += r.buyAmount; totalSellAmt += r.sellAmount; totalPnl += r.pnl; }
            if (r.type === 'open') { totalOpenQty += r.qty; if (r.unrealisedPnl !== undefined) totalUnrealisedPnl += r.unrealisedPnl; }
        });

        var groupLabel = wmsTxnInvName(g.investorId);
        var trdLabel = g.traderId ? wmsTxnInvName(g.traderId) : '';
        var brkLabel = wmsTxnBrkCode(g.brokerId);
        if (trdLabel && trdLabel !== groupLabel) groupLabel += ' > ' + trdLabel;
        if (brkLabel) groupLabel += ' > ' + brkLabel;

        groupResults.push({
            fullSymbol: g.fullSymbol, contractLabel: g.contractLabel,
            groupLabel: groupLabel, isShort: isShort,
            rows: matchedRows, totalQty: totalQty, totalOpenQty: totalOpenQty,
            totalBuyAmt: totalBuyAmt, totalSellAmt: totalSellAmt,
            totalPnl: totalPnl, totalUnrealisedPnl: totalUnrealisedPnl
        });
    });

    if (groupResults.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:#9ca3af;">No matching trades found</td></tr>';
        _wmsTxnRenderMatchSummary(groupResults);
        return;
    }

    var html = '';
    var globalRowIdx = 0;
    groupResults.forEach(function(grp, gi) {
        var groupId = 'wmsMG-' + gi;
        var shortLabel = grp.isShort ? ' <span style="color:#dc2626;font-size:10px;">(Short)</span>' : '';
        var totalPnlClass = grp.totalPnl >= 0 ? 'wms-trM-pnl-positive' : 'wms-trM-pnl-negative';
        var totalPnlHtml = grp.totalPnl < 0
            ? '<span class="' + totalPnlClass + '">(' + formatAmount(Math.abs(grp.totalPnl)) + ')</span>'
            : '<span class="' + totalPnlClass + '">' + formatAmount(grp.totalPnl) + '</span>';
        var startCollapsed = groupResults.length > 1;
        var collapsedClass = startCollapsed ? ' collapsed' : '';

        html += '<tr class="wms-trM-group-header' + collapsedClass + '" data-group-id="' + groupId + '">' +
            '<td colspan="3"><span class="wms-trM-collapse-icon">▼</span> ' + wmsEsc(grp.groupLabel) + ' — ' + wmsEsc(grp.contractLabel) + shortLabel + '</td>' +
            '<td class="wms-trM-buy-start"></td><td></td>' +
            '<td class="text-right"><span class="wms-trM-group-total">' + (grp.totalBuyAmt > 0 ? formatAmount(grp.totalBuyAmt) : '') + '</span></td>' +
            '<td class="wms-trM-sell-start"></td><td></td>' +
            '<td class="text-right"><span class="wms-trM-group-total">' + (grp.totalSellAmt > 0 ? formatAmount(grp.totalSellAmt) : '') + '</span></td>' +
            '<td class="text-right"><span class="wms-trM-group-total">' + totalPnlHtml + '</span></td>' +
        '</tr>';

        grp.rows.forEach(function(row) {
            var rowId = 'wmsMR-' + globalRowIdx++;
            var isOpen = row.type === 'open';
            var rowClass = 'wms-trM-detail-row wms-trM-clickable';
            if (startCollapsed) rowClass += ' collapsed-row';
            if (isOpen) rowClass += ' wms-trM-match-open';
            var buyTxnId = row.buyTxnId || row.openerTxnId || '';
            var sellTxnId = row.sellTxnId || '';

            var pnlHtml = '';
            if (isOpen) {
                if (row.unrealisedPnl !== undefined) {
                    var uFmt = row.unrealisedPnl < 0 ? '(' + formatAmount(Math.abs(row.unrealisedPnl)) + ')' : formatAmount(row.unrealisedPnl);
                    pnlHtml = '<span class="wms-trM-unrealised">' + uFmt + '</span>';
                } else {
                    pnlHtml = '<span class="wms-trM-unrealised">' + (row.isShort ? 'Short Open' : 'Open') + '</span>';
                }
            } else {
                var pnlClass = row.pnl >= 0 ? 'wms-trM-pnl-positive' : 'wms-trM-pnl-negative';
                pnlHtml = row.pnl < 0
                    ? '<span class="' + pnlClass + '">(' + formatAmount(Math.abs(row.pnl)) + ')</span>'
                    : '<span class="' + pnlClass + '">' + formatAmount(row.pnl) + '</span>';
            }

            var hasBuy = row.buyAvg > 0 || row.buyAmount > 0;
            var hasSell = row.sellAvg > 0 || row.sellAmount > 0;
            var buyPriceHtml = hasBuy ? formatPrice(row.buyAvg, false) : '-';
            var buyAmtHtml = hasBuy ? formatAmount(row.buyAmount) : '-';
            var sellPriceHtml = hasSell ? formatPrice(row.sellAvg, false) : '-';
            var sellAmtHtml = hasSell ? formatAmount(row.sellAmount) : '-';
            if (isOpen && row.cmp > 0) {
                if (!row.isShort && !hasSell) { sellPriceHtml = formatPrice(row.cmp, false); sellAmtHtml = '-'; }
                else if (row.isShort && !hasBuy) { buyPriceHtml = formatPrice(row.cmp, false); buyAmtHtml = '-'; }
            }

            html += '<tr class="' + rowClass + '" data-group-id="' + groupId + '" data-row-id="' + rowId + '"' +
                ' data-buy-txn-id="' + buyTxnId + '" data-sell-txn-id="' + sellTxnId + '">' +
                '<td>' + wmsEsc(grp.groupLabel) + '</td>' +
                '<td class="wms-trM-contract-col">' + wmsEsc(grp.contractLabel) + '</td>' +
                '<td class="text-right">' + formatQuantity(row.qty) + '</td>' +
                '<td class="wms-trM-buy-start">' + (row.buyDate ? formatDate(row.buyDate) : '-') + '</td>' +
                '<td class="text-right">' + buyPriceHtml + '</td>' +
                '<td class="text-right">' + buyAmtHtml + '</td>' +
                '<td class="wms-trM-sell-start">' + (row.sellDate ? formatDate(row.sellDate) : '-') + '</td>' +
                '<td class="text-right">' + sellPriceHtml + '</td>' +
                '<td class="text-right">' + sellAmtHtml + '</td>' +
                '<td class="text-right">' + pnlHtml + '</td>' +
            '</tr>';
        });
    });

    tbody.innerHTML = html;

    // Collapse/expand
    tbody.querySelectorAll('.wms-trM-group-header').forEach(function(header) {
        header.addEventListener('click', function() {
            var gid = header.dataset.groupId;
            var isCollapsed = header.classList.toggle('collapsed');
            tbody.querySelectorAll('.wms-trM-detail-row[data-group-id="' + gid + '"]').forEach(function(row) {
                if (isCollapsed) row.classList.add('collapsed-row'); else row.classList.remove('collapsed-row');
            });
        });
    });

    // Click to edit
    tbody.querySelectorAll('.wms-trM-clickable').forEach(function(row) {
        row.addEventListener('click', function(e) {
            if (e.target.closest('.wms-trM-group-header')) return;
            var cell = e.target.closest('td');
            var allTds = Array.prototype.slice.call(row.children);
            var cellIdx = allTds.indexOf(cell);
            var txnId = '';
            if (cellIdx >= 6 && cellIdx <= 8 && row.dataset.sellTxnId) txnId = row.dataset.sellTxnId;
            else if (row.dataset.buyTxnId) txnId = row.dataset.buyTxnId;
            else if (row.dataset.sellTxnId) txnId = row.dataset.sellTxnId;
            if (txnId) wmsEditModalOpen(txnId);
        });
    });

    _wmsTxnRenderMatchSummary(groupResults);
}

function _wmsTxnRenderMatchSummary(groupResults) {
    var container = document.getElementById('wmsTxnMatchSummary');
    if (!container) return;
    var totalMatchedQty = 0, totalBuyAmt = 0, totalSellAmt = 0, totalPnl = 0, totalOpenQty = 0, totalUnrealisedPnl = 0;
    var hasUnrealised = false;
    groupResults.forEach(function(grp) {
        totalBuyAmt += grp.totalBuyAmt; totalSellAmt += grp.totalSellAmt;
        totalPnl += grp.totalPnl; totalMatchedQty += grp.totalQty;
        totalOpenQty += (grp.totalOpenQty || 0);
        if (grp.totalUnrealisedPnl) { totalUnrealisedPnl += grp.totalUnrealisedPnl; hasUnrealised = true; }
    });
    var pnlPct = totalBuyAmt !== 0 ? (totalPnl / totalBuyAmt) * 100 : 0;
    container.innerHTML =
        '<div class="wms-txn-summary-card"><div class="summary-label">Open Position</div><div class="summary-value">' + formatQuantity(totalOpenQty) + '</div><div class="summary-sub">Matched: ' + formatQuantity(totalMatchedQty) + '</div></div>' +
        '<div class="wms-txn-summary-card"><div class="summary-label">Total Buy</div><div class="summary-value">' + formatAmount(totalBuyAmt) + '</div></div>' +
        '<div class="wms-txn-summary-card ' + getAmountClass(totalPnl) + '"><div class="summary-label">Realised P&L</div><div class="summary-value ' + getAmountClass(totalPnl) + '">' + formatAmount(totalPnl) + '</div><div class="summary-sub ' + getAmountClass(totalPnl) + '">' + formatPercent(pnlPct) + ' on buy</div></div>' +
        (hasUnrealised ? '<div class="wms-txn-summary-card ' + getAmountClass(totalUnrealisedPnl) + '"><div class="summary-label">Unrealised P&L</div><div class="summary-value ' + getAmountClass(totalUnrealisedPnl) + '">' + formatAmount(totalUnrealisedPnl) + '</div></div>' : '');
}

// Expiry label helper
function _wmsTxnGetExpiryLabel(contractLabel) {
    if (!contractLabel || contractLabel === 'Equity') return 'Equity';
    var parts = contractLabel.split(' ');
    if (parts.length >= 3) {
        var monthIdx = { Jan:1, Feb:1, Mar:1, Apr:1, May:1, Jun:1, Jul:1, Aug:1, Sep:1, Oct:1, Nov:1, Dec:1 };
        if (monthIdx[parts[1]]) return parts[1] + ' ' + parts[2];
    }
    return contractLabel;
}

// Contract filter dropdown
function _wmsTxnBuildContractFilter(contractLabels) {
    var wrap = document.getElementById('wmsTxnContractFilterWrap');
    if (!wrap) return;
    if (contractLabels.length <= 1) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var html = '<button class="wms-trM-cf-btn" id="wmsMCfToggle">Expiry ▾</button>' +
        '<div class="wms-trM-cf-dropdown" id="wmsMCfDropdown" style="display:none;">';
    contractLabels.forEach(function(cl) {
        var checked = (wmsTxnContractFilter.length === 0 || wmsTxnContractFilter.indexOf(cl) >= 0) ? ' checked' : '';
        html += '<label class="wms-trM-cf-item"><input type="checkbox" value="' + wmsEsc(cl) + '"' + checked + '> ' + wmsEsc(cl) + '</label>';
    });
    html += '</div>';
    wrap.innerHTML = html;
    var toggleBtn = document.getElementById('wmsMCfToggle');
    var dropdown = document.getElementById('wmsMCfDropdown');
    toggleBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none';
    });
    dropdown.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
        cb.addEventListener('change', function() {
            var checked = [];
            dropdown.querySelectorAll('input[type="checkbox"]:checked').forEach(function(c) { checked.push(c.value); });
            wmsTxnContractFilter = checked.length === contractLabels.length ? [] : checked;
            wmsTxnRefreshCurrentView();
        });
    });
    document.addEventListener('click', function(e) {
        if (!wrap.contains(e.target)) dropdown.style.display = 'none';
    });
}

// ============================================================================
// TOGGLE FLAGS (dont_display, ignore_for_avg_cost)
// ============================================================================

async function wmsToggleTxnFlag(txnId, flagName) {
    if (!wmsTxnCtx) return;
    var txn = wmsTxnCtx.transactions.find(function(t) { return t.id === txnId; });
    if (!txn) return;
    if (txn.is_locked) { showAlert('Transaction is locked. Unlock it first.', 'error'); return; }

    var newValue = !txn[flagName];
    var body = {};
    body[flagName] = newValue;

    var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txnId, {
        method: 'PATCH',
        headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
        body: JSON.stringify(body)
    });

    if (resp.ok) {
        txn[flagName] = newValue;
        showAlert(flagName.replace(/_/g, ' ') + ' ' + (newValue ? 'enabled' : 'disabled'), 'success', 2000);
        wmsTxnRefreshCurrentView();
        if (wmsTxnCtx.afterChange) wmsTxnCtx.afterChange();
    } else {
        showAlert('Failed to update: HTTP ' + resp.status, 'error');
    }
}

// ============================================================================
// DELETE TRANSACTION
// ============================================================================

async function wmsDeleteTransaction(txnId) {
    if (!wmsTxnCtx) return;
    var txn = wmsTxnCtx.transactions.find(function(t) { return t.id === txnId; });
    if (!txn) return;
    if (txn.is_locked) { showAlert('Transaction is locked. Unlock it first.', 'error'); return; }
    if (!confirm('Delete this ' + txn.transaction_type + ' transaction for ' + txn.symbol + '?\n\nThis cannot be undone.')) return;

    var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txnId, {
        method: 'DELETE',
        headers: wmsHeaders({'Prefer': 'return=minimal'})
    });

    if (resp.ok) {
        var idx = wmsTxnCtx.transactions.indexOf(txn);
        if (idx >= 0) wmsTxnCtx.transactions.splice(idx, 1);
        showAlert('Transaction deleted', 'success', 2000);
        if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
        wmsTxnRefreshCurrentView();
        if (wmsTxnCtx.afterChange) wmsTxnCtx.afterChange();
    } else {
        showAlert('Failed to delete: HTTP ' + resp.status, 'error');
    }
}

// ============================================================================
// EDIT MODAL: OPEN / CLOSE
// ============================================================================

function wmsEditModalOpen(txnId) {
    _wmsTxnEnsureDom();
    if (!wmsTxnCtx) return;

    var txn = wmsTxnCtx.transactions.find(function(t) { return t.id === txnId; });
    if (!txn) return;
    wmsEditingTxnId = txnId;

    var isSell = txn.transaction_type === 'SELL';

    // Banner
    document.getElementById('wmsEditBannerSymbol').textContent = txn.short_symbol || txn.symbol || '-';
    document.getElementById('wmsEditBannerCompany').textContent = txn.company_name || '';
    document.getElementById('wmsEditBannerType').textContent = txn.security_type || '-';

    // Parties
    document.getElementById('wmsEditInvestor').value = wmsTxnInvName(txn.investor_id);
    document.getElementById('wmsEditBroker').value = wmsTxnBrkCode(txn.broker_id) || '-';
    document.getElementById('wmsEditCnNo').value = txn.broker_contract_note_no || '';

    // Trader dropdown
    var traderSelect = document.getElementById('wmsEditTrader');
    traderSelect.innerHTML = '<option value="">(Same as Investor)</option>' +
        (wmsTxnCtx.investors || []).map(function(inv) {
            var label = inv.short_name || inv.name;
            var selected = inv.id === txn.trader_id ? ' selected' : '';
            return '<option value="' + inv.id + '"' + selected + '>' + label + '</option>';
        }).join('');

    // Trade details
    document.getElementById('wmsEditDate').value = formatDate(txn.transaction_date);
    document.getElementById('wmsEditType').value = txn.transaction_type || '-';
    document.getElementById('wmsEditExchange').value = txn.exchange || '-';
    document.getElementById('wmsEditProduct').value = txn.product || '-';

    var lotsVal = parseFloat(txn.lots) || 0;
    var qtyVal = txn.quantity || 0;
    document.getElementById('wmsEditLots').value = wmsEditFmt(isSell ? Math.abs(lotsVal) : lotsVal);
    document.getElementById('wmsEditQty').value = wmsEditFmtInt(isSell ? Math.abs(qtyVal) : qtyVal);
    document.getElementById('wmsEditPrice').value = wmsEditFmt(txn.price || 0);
    document.getElementById('wmsEditGross').value = wmsEditFmt(txn.gross_amount || 0);

    // Charges
    document.getElementById('wmsEditBrokerage').value = wmsEditFmt(txn.brokerage || 0);
    document.getElementById('wmsEditStt').value = wmsEditFmt(txn.stt || 0);
    document.getElementById('wmsEditOther').value = wmsEditFmt(txn.other_charges || 0);
    document.getElementById('wmsEditGst').value = wmsEditFmt(txn.gst || 0);
    document.getElementById('wmsEditTds').value = wmsEditFmt(txn.tds || 0);
    document.getElementById('wmsEditTotalCharges').value = wmsEditFmt(txn.total_charges || 0);
    document.getElementById('wmsEditNetAmount').value = wmsEditFmt(txn.net_amount || 0);
    document.getElementById('wmsEditTraderCharges').value = wmsEditFmt(txn.trader_charges || 0);
    document.getElementById('wmsEditMargin').value = wmsEditFmt(txn.margin_blocked || 0);

    // Tags
    if (wmsEditTagCtrl) { wmsEditTagCtrl.destroy(); wmsEditTagCtrl = null; }
    var currentTags = (txn.tags || []).filter(function(t) { return !!t; });
    var allExistingTags = {};
    wmsTxnCtx.transactions.forEach(function(t) {
        if (t.tags) t.tags.forEach(function(tag) { if (tag) allExistingTags[tag] = true; });
    });
    var tagInput = document.getElementById('wmsEditTagsInput');
    var tagPills = document.getElementById('wmsEditTagPills');
    var tagDd = document.getElementById('wmsEditTagDd');
    tagInput.value = ''; tagPills.innerHTML = ''; tagDd.innerHTML = '';
    if (typeof wmsTagInput === 'function') {
        wmsEditTagCtrl = wmsTagInput(tagInput, tagPills, tagDd, {
            tags: currentTags.slice(),
            existingTags: Object.keys(allExistingTags).sort(),
            onChange: function() {}
        });
    }

    // Notes
    document.getElementById('wmsEditNotes').value = txn.notes || '';

    // Flags
    document.getElementById('wmsEditLocked').checked = !!txn.is_locked;
    document.getElementById('wmsEditIgnoreAvg').checked = !!txn.ignore_for_avg_cost;
    document.getElementById('wmsEditDontDisplay').checked = !!txn.dont_display;

    // Lock warning
    document.getElementById('wmsEditLockWarning').style.display = txn.is_locked ? '' : 'none';

    // Reset split
    document.getElementById('wmsSplitSection').style.display = 'none';
    document.getElementById('wmsSplitQty').value = '';
    document.getElementById('wmsSplitStatus').textContent = '';

    // Disable if locked
    var isLocked = !!txn.is_locked;
    document.querySelectorAll('#wmsEditForm .editable-field, #wmsEditForm select.editable-field, #wmsEditForm input[type="checkbox"]:not(#wmsEditLocked)').forEach(function(f) { f.disabled = isLocked; });
    document.getElementById('wmsEditSaveBtn').disabled = isLocked;
    document.getElementById('wmsEditDeleteBtn').disabled = isLocked;
    document.getElementById('wmsSplitBtn').disabled = isLocked;
    document.getElementById('wmsEditModalTitle').textContent = isLocked ? 'View Transaction (Locked)' : 'Edit Transaction';

    document.getElementById('wmsEditModal').classList.add('show');
}

function wmsEditModalClose() {
    document.getElementById('wmsEditModal').classList.remove('show');
    wmsEditingTxnId = null;
    _wmsSplitData = null;
}

// ============================================================================
// EDIT MODAL: RECALCULATE
// ============================================================================

function wmsRecalcEditAmounts() {
    if (!wmsEditingTxnId || !wmsTxnCtx) return;
    var txn = wmsTxnCtx.transactions.find(function(t) { return t.id === wmsEditingTxnId; });
    if (!txn) return;

    var qty = wmsEditParse(document.getElementById('wmsEditQty'));
    var price = wmsEditParse(document.getElementById('wmsEditPrice'));
    var gross = wmsRoundMoney(Math.abs(qty) * price);
    document.getElementById('wmsEditGross').value = wmsEditFmt(gross);

    var isSell = txn.transaction_type === 'SELL';
    var tempRow = {
        quantity: isSell ? -qty : qty, price: price, gross_amount: gross,
        transaction_type: txn.transaction_type, security_type: txn.security_type,
        asset_class: txn.asset_class, exchange: txn.exchange, product: txn.product,
        lots: parseFloat(txn.lots) || 0, lot_size: txn.lot_size || 1,
        brokerage: 0, stt: 0, other_charges: 0, gst: 0, tds: 0,
        total_charges: 0, trader_charges: 0, net_amount: 0,
        _exchange_charges: 0, _sebi_charges: 0, _stamp_duty: 0, _ipft: 0
    };

    if (typeof wmsAutoCalcCharges === 'function' && wmsRefData) {
        wmsAutoCalcCharges(tempRow, {
            ibaRatesMap: wmsRefData.ibaRatesMap, regCharges: wmsRefData.regCharges,
            investorId: txn.investor_id, brokerId: txn.broker_id,
            preserveExisting: false, debug: false
        });
    }

    document.getElementById('wmsEditBrokerage').value = wmsEditFmt(tempRow.brokerage);
    document.getElementById('wmsEditStt').value = wmsEditFmt(tempRow.stt);
    document.getElementById('wmsEditOther').value = wmsEditFmt(tempRow.other_charges);
    document.getElementById('wmsEditGst').value = wmsEditFmt(tempRow.gst);
    document.getElementById('wmsEditTotalCharges').value = wmsEditFmt(tempRow.total_charges);
    document.getElementById('wmsEditNetAmount').value = wmsEditFmt(tempRow.net_amount);

    wmsRecalcTraderCharges();
    wmsRecalcMargin();
}

function wmsRecalcMargin() {
    if (!wmsEditingTxnId || !wmsTxnCtx) return;
    var txn = wmsTxnCtx.transactions.find(function(t) { return t.id === wmsEditingTxnId; });
    if (!txn) return;
    var product = txn.product || '';
    if (product !== 'F&O' && product !== 'FNO') return;
    var netAmount = wmsEditParse(document.getElementById('wmsEditNetAmount'));
    var marginRate = wmsGetMarginRate(txn.investor_id, txn.broker_id);
    var margin = wmsCalcMarginBlocked(netAmount, marginRate);
    document.getElementById('wmsEditMargin').value = wmsEditFmt(margin);
}

function wmsRecalcTraderCharges() {
    if (!wmsEditingTxnId || !wmsTxnCtx) return;
    var txn = wmsTxnCtx.transactions.find(function(t) { return t.id === wmsEditingTxnId; });
    if (!txn) return;
    var traderId = document.getElementById('wmsEditTrader').value || txn.investor_id;
    var investorId = txn.investor_id;
    var brokerId = txn.broker_id;
    if (traderId !== investorId && wmsRefData && wmsRefData.ibaRatesMap) {
        var gross = Math.abs(parseFloat(txn.gross_amount) || 0);
        var inclusive = wmsIsChargesInclusive(wmsRefData.ibaRatesMap, investorId, brokerId);
        var traderCharges = wmsGetBrokerage(wmsRefData.ibaRatesMap, traderId, brokerId, gross,
            txn.security_type, txn.asset_class, txn.price, txn.quantity, txn.lots, inclusive);
        document.getElementById('wmsEditTraderCharges').value = wmsEditFmt(traderCharges);
    } else {
        document.getElementById('wmsEditTraderCharges').value = wmsEditFmt(0);
    }
}

// ============================================================================
// EDIT MODAL: SAVE
// ============================================================================

async function wmsEditSave() {
    if (!wmsEditingTxnId || !wmsTxnCtx) return;
    var txn = wmsTxnCtx.transactions.find(function(t) { return t.id === wmsEditingTxnId; });
    if (!txn) return;
    if (txn.is_locked) { showAlert('Transaction is locked and cannot be edited.', 'error'); return; }

    var tags = wmsEditTagCtrl ? wmsEditTagCtrl.getTags() : [];
    if (tags.length === 0) tags = ['blank'];

    var traderVal = document.getElementById('wmsEditTrader').value;
    var isSell = txn.transaction_type === 'SELL';
    var editedQty = wmsEditParse(document.getElementById('wmsEditQty'));
    var editedPrice = wmsEditParse(document.getElementById('wmsEditPrice'));
    if (isSell && editedQty > 0) editedQty = -editedQty;

    var body = {
        trader_id: traderVal || null,
        quantity: editedQty,
        price: editedPrice,
        gross_amount: wmsEditParse(document.getElementById('wmsEditGross')),
        brokerage: wmsEditParse(document.getElementById('wmsEditBrokerage')),
        stt: wmsEditParse(document.getElementById('wmsEditStt')),
        other_charges: wmsEditParse(document.getElementById('wmsEditOther')),
        gst: wmsEditParse(document.getElementById('wmsEditGst')),
        tds: wmsEditParse(document.getElementById('wmsEditTds')),
        total_charges: wmsEditParse(document.getElementById('wmsEditTotalCharges')),
        net_amount: wmsEditParse(document.getElementById('wmsEditNetAmount')),
        trader_charges: wmsEditParse(document.getElementById('wmsEditTraderCharges')),
        margin_blocked: wmsEditParse(document.getElementById('wmsEditMargin')),
        broker_contract_note_no: document.getElementById('wmsEditCnNo').value.trim() || null,
        tags: tags,
        notes: document.getElementById('wmsEditNotes').value || null,
        ignore_for_avg_cost: document.getElementById('wmsEditIgnoreAvg').checked,
        dont_display: document.getElementById('wmsEditDontDisplay').checked
    };

    var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + wmsEditingTxnId, {
        method: 'PATCH',
        headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
        body: JSON.stringify(body)
    });

    if (resp.ok) {
        Object.keys(body).forEach(function(k) { txn[k] = body[k]; });
        if (typeof wmsComputeDisplayNetAmount === 'function') txn.display_net_amount = wmsComputeDisplayNetAmount(txn);
        showAlert('Transaction saved', 'success', 2000);
        wmsEditModalClose();
        wmsTxnRefreshCurrentView();
        if (wmsTxnCtx.afterChange) wmsTxnCtx.afterChange();
    } else {
        var errText = await resp.text();
        showAlert('Failed to save: ' + errText, 'error');
    }
}

// ============================================================================
// SPLIT TRANSACTION
// ============================================================================

function wmsToggleSplitPanel() {
    var section = document.getElementById('wmsSplitSection');
    var isVisible = section.style.display !== 'none';
    if (isVisible) { section.style.display = 'none'; return; }
    if (!wmsTxnCtx) return;
    var txn = wmsTxnCtx.transactions.find(function(t) { return t.id === wmsEditingTxnId; });
    if (!txn) return;
    var sel = document.getElementById('wmsSplitTrader');
    sel.innerHTML = '<option value="">(Same as Investor)</option>' +
        (wmsTxnCtx.investors || []).map(function(inv) {
            return '<option value="' + inv.id + '">' + (inv.short_name || inv.name) + '</option>';
        }).join('');
    document.getElementById('wmsSplitQty').value = '';
    document.getElementById('wmsSplitStatus').textContent = '';
    document.getElementById('wmsSplitPreview').style.display = 'none';
    document.getElementById('wmsSplitPreviewBody').innerHTML = '';
    section.style.display = '';
    document.getElementById('wmsSplitQty').focus();
}

function _wmsCalcSplitTraderCharges(txn, traderId, splitGross, splitQty, splitLots) {
    if (!traderId || traderId === txn.investor_id) return 0;
    if (!wmsRefData || !wmsRefData.ibaRatesMap) return 0;
    var inclusive = wmsIsChargesInclusive(wmsRefData.ibaRatesMap, txn.investor_id, txn.broker_id);
    return wmsGetBrokerage(wmsRefData.ibaRatesMap, traderId, txn.broker_id,
        Math.abs(splitGross), txn.security_type, txn.asset_class, txn.price, splitQty, splitLots, inclusive) || 0;
}

function wmsPreviewSplit() {
    if (!wmsTxnCtx) return;
    var txn = wmsTxnCtx.transactions.find(function(t) { return t.id === wmsEditingTxnId; });
    if (!txn) return;
    var statusEl = document.getElementById('wmsSplitStatus');
    statusEl.textContent = ''; statusEl.style.color = '';

    var splitQtyAbs = parseFloat((document.getElementById('wmsSplitQty').value || '0').replace(/,/g, ''));
    if (!splitQtyAbs || splitQtyAbs <= 0) {
        statusEl.textContent = 'Enter a valid quantity to split off.'; statusEl.style.color = '#dc2626'; return;
    }
    var isSell = txn.transaction_type === 'SELL';
    var origQtyAbs = Math.abs(txn.quantity || 0);
    if (splitQtyAbs >= origQtyAbs) {
        statusEl.textContent = 'Split qty must be less than original qty (' + wmsEditFmtInt(origQtyAbs) + ').'; statusEl.style.color = '#dc2626'; return;
    }

    var ratio = splitQtyAbs / origQtyAbs;
    function r2(v) { return Math.round((v || 0) * 100) / 100; }
    var splitTraderVal = document.getElementById('wmsSplitTrader').value || null;

    // Remaining
    var remainQtyAbs = origQtyAbs - splitQtyAbs;
    var remainQty = isSell ? -remainQtyAbs : remainQtyAbs;
    var remainLots = r2((txn.lots || 0) * (1 - ratio));
    var remainGross = r2((txn.gross_amount || 0) * (1 - ratio));
    var remainBrokerage = r2((txn.brokerage || 0) * (1 - ratio));
    var remainStt = r2((txn.stt || 0) * (1 - ratio));
    var remainOther = r2((txn.other_charges || 0) * (1 - ratio));
    var remainGst = r2((txn.gst || 0) * (1 - ratio));
    var remainTds = r2((txn.tds || 0) * (1 - ratio));
    var remainTotalCharges = r2(remainBrokerage + remainStt + remainOther + remainGst);
    var remainNet = wmsIsBuyLikeType(txn.transaction_type) ? r2(remainGross + remainTotalCharges) : r2(remainGross - remainTotalCharges);
    var origTraderId = txn.trader_id || txn.investor_id;
    var remainTraderCharges = _wmsCalcSplitTraderCharges(txn, origTraderId, remainGross, remainQty, remainLots);

    // Split-off
    var splitQty = isSell ? -splitQtyAbs : splitQtyAbs;
    var splitLots = r2((txn.lots || 0) * ratio);
    var splitGross = r2((txn.gross_amount || 0) * ratio);
    var splitBrokerage = r2((txn.brokerage || 0) * ratio);
    var splitStt = r2((txn.stt || 0) * ratio);
    var splitOther = r2((txn.other_charges || 0) * ratio);
    var splitGst = r2((txn.gst || 0) * ratio);
    var splitTds = r2((txn.tds || 0) * ratio);
    var splitTotalCharges = r2(splitBrokerage + splitStt + splitOther + splitGst);
    var splitNet = wmsIsBuyLikeType(txn.transaction_type) ? r2(splitGross + splitTotalCharges) : r2(splitGross - splitTotalCharges);
    var splitTraderId = splitTraderVal || txn.investor_id;
    var splitTraderCharges = _wmsCalcSplitTraderCharges(txn, splitTraderId, splitGross, splitQty, splitLots);

    var origTraderName = '(Investor)';
    if (origTraderId && origTraderId !== txn.investor_id) {
        var inv = (wmsTxnCtx.investors || []).find(function(i) { return i.id === origTraderId; });
        origTraderName = inv ? (inv.short_name || inv.name) : origTraderId;
    }
    var splitTraderName = '(Investor)';
    if (splitTraderId && splitTraderId !== txn.investor_id) {
        var inv2 = (wmsTxnCtx.investors || []).find(function(i) { return i.id === splitTraderId; });
        splitTraderName = inv2 ? (inv2.short_name || inv2.name) : splitTraderId;
    }

    var f = wmsEditFmt, fi = wmsEditFmtInt;
    function row(label, trader, qty, price, gross, charges, traderChg, net, bg) {
        return '<tr style="border-bottom:1px solid #f1f5f9;background:' + bg + ';"><td style="padding:4px 6px;font-weight:600;">' + label + '</td><td style="padding:4px 6px;">' + trader + '</td><td style="padding:4px 6px;text-align:right;">' + fi(qty) + '</td><td style="padding:4px 6px;text-align:right;">' + f(price) + '</td><td style="padding:4px 6px;text-align:right;">' + f(gross) + '</td><td style="padding:4px 6px;text-align:right;">' + f(charges) + '</td><td style="padding:4px 6px;text-align:right;">' + f(traderChg) + '</td><td style="padding:4px 6px;text-align:right;">' + f(net) + '</td></tr>';
    }

    document.getElementById('wmsSplitPreviewBody').innerHTML =
        row('Original', origTraderName, remainQtyAbs, txn.price, Math.abs(remainGross), Math.abs(remainTotalCharges), remainTraderCharges, Math.abs(remainNet), '#fff') +
        row('Split-off', splitTraderName, splitQtyAbs, txn.price, Math.abs(splitGross), Math.abs(splitTotalCharges), splitTraderCharges, Math.abs(splitNet), '#f5f3ff');
    document.getElementById('wmsSplitPreview').style.display = '';

    _wmsSplitData = {
        newTxn: {
            investor_id: txn.investor_id, broker_id: txn.broker_id, trader_id: splitTraderVal,
            security_id: txn.security_id, security_type: txn.security_type,
            symbol: txn.symbol, short_symbol: txn.short_symbol, company_name: txn.company_name,
            asset_class: txn.asset_class, exchange: txn.exchange, product: txn.product,
            transaction_type: txn.transaction_type, transaction_date: txn.transaction_date,
            quantity: splitQty, lots: splitLots, price: txn.price,
            gross_amount: splitGross, brokerage: splitBrokerage, stt: splitStt,
            other_charges: splitOther, gst: splitGst, tds: splitTds,
            total_charges: splitTotalCharges, net_amount: splitNet,
            trader_charges: splitTraderCharges,
            margin_blocked: r2((txn.margin_blocked || 0) * ratio),
            broker_contract_note_no: txn.broker_contract_note_no, broker_trade_id: null,
            tags: (txn.tags || []).slice(),
            notes: '[SPLIT from txn ' + txn.id + '] ' + (txn.notes || ''),
            ignore_for_avg_cost: txn.ignore_for_avg_cost || false,
            dont_display: txn.dont_display || false
        },
        origUpdate: {
            quantity: remainQty, lots: remainLots, gross_amount: remainGross,
            brokerage: remainBrokerage, stt: remainStt, other_charges: remainOther,
            gst: remainGst, tds: remainTds, total_charges: remainTotalCharges,
            net_amount: remainNet, trader_charges: remainTraderCharges,
            margin_blocked: r2((txn.margin_blocked || 0) * (1 - ratio))
        }
    };
}

async function wmsExecuteSplit() {
    if (!wmsEditingTxnId || !_wmsSplitData || !wmsTxnCtx) return;
    var txn = wmsTxnCtx.transactions.find(function(t) { return t.id === wmsEditingTxnId; });
    if (!txn) return;

    var statusEl = document.getElementById('wmsSplitStatus');
    statusEl.textContent = 'Splitting...'; statusEl.style.color = '#718096';
    document.getElementById('wmsSplitConfirmBtn').disabled = true;

    try {
        var insertResp = await fetch(SUPABASE_URL + '/rest/v1/transactions', {
            method: 'POST',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify(_wmsSplitData.newTxn)
        });
        if (!insertResp.ok) throw new Error('Insert failed: ' + (await insertResp.text()));
        var insertedRows = await insertResp.json();
        var insertedTxn = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;

        var patchResp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txn.id, {
            method: 'PATCH',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=minimal'}),
            body: JSON.stringify(_wmsSplitData.origUpdate)
        });
        if (!patchResp.ok) throw new Error('Update original failed: ' + (await patchResp.text()));

        Object.keys(_wmsSplitData.origUpdate).forEach(function(k) { txn[k] = _wmsSplitData.origUpdate[k]; });
        if (typeof wmsComputeDisplayNetAmount === 'function') txn.display_net_amount = wmsComputeDisplayNetAmount(txn);
        if (insertedTxn && typeof wmsComputeDisplayNetAmount === 'function') insertedTxn.display_net_amount = wmsComputeDisplayNetAmount(insertedTxn);
        if (insertedTxn) wmsTxnCtx.transactions.push(insertedTxn);
        _wmsSplitData = null;

        showAlert('Transaction split successfully', 'success', 2500);
        wmsEditModalClose();
        wmsTxnRefreshCurrentView();
        if (wmsTxnCtx.afterChange) wmsTxnCtx.afterChange();
    } catch (err) {
        statusEl.textContent = 'Error: ' + err.message; statusEl.style.color = '#dc2626';
        document.getElementById('wmsSplitConfirmBtn').disabled = false;
    }
}

// ============================================================================
// EXPORTS (make available globally)
// ============================================================================
window.wmsTxnCtx = null;  // modules set this before opening
window.wmsTxnModalOpen = wmsTxnModalOpen;
window.wmsTxnModalClose = wmsTxnModalClose;
window.wmsEditModalOpen = wmsEditModalOpen;
window.wmsEditModalClose = wmsEditModalClose;
