// Configuration
// SUPABASE_URL defined in app.html
// SUPABASE_ANON_KEY defined in app.html

// State
var brokerAccountCounter = 0;
var editingInvestorId = null;
var editingBrokerId = null;
var _chargesData = [];
var _chargesLoaded = false;

// Universal Data Layer
var DB = {
    mode: null,
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_ANON_KEY,
    
    init() {
        const hostname = window.location.hostname;
        if (hostname === 'vikashbagla.github.io' || hostname.includes('github.io')) {
            this.mode = 'supabase';
        } else {
            this.mode = 'local';
        }
        this.updateModeIndicator();
        return this.mode;
    },
    
    updateModeIndicator() {
        const indicator = document.getElementById('modeIndicator');
        if (!indicator) return; // element may not exist in embedded mode
        if (this.mode === 'local') {
            indicator.className = 'mode-indicator mode-local';
            indicator.textContent = '🔵 LOCAL';
        } else {
            indicator.className = 'mode-indicator mode-supabase';
            indicator.textContent = '🟢 LIVE';
        }
    },
    
    async getInvestors() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/investors?select=*&order=name.asc`, {
            headers: wmsHeaders()
        });
        return await response.json();
    },
    
    async addInvestor(data) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/investors`, {
            method: 'POST',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify(data)
        });
        const result = await response.json();
        return result[0];
    },
    
    async updateInvestor(id, data) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/investors?id=eq.${id}`, {
            method: 'PATCH',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify(data)
        });
        const result = await response.json();
        return result[0];
    },
    
    async deleteInvestor(id) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/investors?id=eq.${id}`, {
            method: 'DELETE',
            headers: wmsHeaders()
        });
        return response.ok;
    },
    
    async getBrokers() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/brokers?select=*&order=name.asc`, {
            headers: wmsHeaders()
        });
        return await response.json();
    },
    
    async addBroker(data) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/brokers`, {
            method: 'POST',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify(data)
        });
        const result = await response.json();
        return result[0];
    },
    
    async updateBroker(id, data) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/brokers?id=eq.${id}`, {
            method: 'PATCH',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify(data)
        });
        const result = await response.json();
        return result[0];
    },
    
    async deleteBroker(id) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/brokers?id=eq.${id}`, {
            method: 'DELETE',
            headers: wmsHeaders()
        });
        return response.ok;
    },
    
    async getBrokerAccounts(investorId) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/investor_broker_accounts?investor_id=eq.${investorId}&select=*`, {
            headers: wmsHeaders()
        });
        return await response.json();
    },
    
    async getAllBrokerAccounts() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/investor_broker_accounts?select=*`, {
            headers: wmsHeaders()
        });
        return await response.json();
    },
    
    async saveBrokerAccounts(investorId, accounts) {
        // Safe upsert: update existing, insert new, delete removed
        // First get current accounts to know which exist
        var existing = await this.getBrokerAccounts(investorId);
        var existingByBroker = {};
        existing.forEach(function(a) { existingByBroker[a.broker_id] = a; });

        var newBrokerIds = {};
        for (var i = 0; i < accounts.length; i++) {
            var acc = accounts[i];
            newBrokerIds[acc.broker_id] = true;
            var payload = Object.assign({}, acc, { investor_id: investorId, is_active: true });

            if (existingByBroker[acc.broker_id]) {
                // PATCH existing record
                var existingId = existingByBroker[acc.broker_id].id;
                await fetch(`${this.supabaseUrl}/rest/v1/investor_broker_accounts?id=eq.${existingId}`, {
                    method: 'PATCH',
                    headers: wmsHeaders({'Content-Type': 'application/json'}),
                    body: JSON.stringify(payload)
                });
            } else {
                // POST new record
                await fetch(`${this.supabaseUrl}/rest/v1/investor_broker_accounts`, {
                    method: 'POST',
                    headers: wmsHeaders({'Content-Type': 'application/json'}),
                    body: JSON.stringify(payload)
                });
            }
        }

        // Delete accounts that were removed from the form
        for (var j = 0; j < existing.length; j++) {
            if (!newBrokerIds[existing[j].broker_id]) {
                await fetch(`${this.supabaseUrl}/rest/v1/investor_broker_accounts?id=eq.${existing[j].id}`, {
                    method: 'DELETE',
                    headers: wmsHeaders()
                });
            }
        }
        return Promise.resolve(true);
    },
    
    async getUser() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/users?select=*&limit=1`, {
            headers: wmsHeaders()
        });
        const users = await response.json();
        return users[0] || null;
    },
    
    async updateUserPreferences(preferences) {
        const user = await this.getUser();
        if (user) {
            await fetch(`${this.supabaseUrl}/rest/v1/users?id=eq.${user.id}`, {
                method: 'PATCH',
                headers: wmsHeaders({'Content-Type': 'application/json'}),
                body: JSON.stringify({ preferences })
            });
        }
    },

    async getChargesConfig() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/regulatory_charges_config?effective_to=is.null&order=exchange.asc,charge_type.asc,transaction_category.asc,transaction_type.asc`, {
            headers: wmsHeaders()
        });
        return await response.json();
    },

    async expireChargeRow(id, effectiveTo) {
        await fetch(`${this.supabaseUrl}/rest/v1/regulatory_charges_config?id=eq.${id}`, {
            method: 'PATCH',
            headers: wmsHeaders({'Content-Type': 'application/json'}),
            body: JSON.stringify({ effective_to: effectiveTo })
        });
    },

    async insertChargeRows(rows) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/regulatory_charges_config`, {
            method: 'POST',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify(rows)
        });
        var data = await response.json();
        if (!response.ok) {
            console.error('Insert charges failed:', response.status, data);
            throw new Error(data.message || data.details || ('HTTP ' + response.status));
        }
        return data;
    },

    // ==================== LEDGER ENTRIES ====================

    async getLedgerEntries(filters) {
        // filters: { investorId, traderId, brokerId, entryType, dateFrom, dateTo }
        var q = 'select=*&order=entry_date.asc,created_at.asc';
        if (filters.investorId) q += '&investor_id=eq.' + filters.investorId;
        if (filters.traderId) q += '&trader_id=eq.' + filters.traderId;
        if (filters.brokerId) q += '&broker_id=eq.' + filters.brokerId;
        if (filters.entryType) q += '&entry_type=eq.' + filters.entryType;
        if (filters.dateFrom) q += '&entry_date=gte.' + filters.dateFrom;
        if (filters.dateTo) q += '&entry_date=lte.' + filters.dateTo;
        const response = await fetch(`${this.supabaseUrl}/rest/v1/ledger_entries?${q}`, {
            headers: wmsHeaders()
        });
        return await response.json();
    },

    async addLedgerEntry(data) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/ledger_entries`, {
            method: 'POST',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify(data)
        });
        var result = await response.json();
        if (!response.ok) throw new Error(result.message || result.details || ('HTTP ' + response.status));
        return result[0];
    },

    async updateLedgerEntry(id, data) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/ledger_entries?id=eq.${id}`, {
            method: 'PATCH',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify(data)
        });
        var result = await response.json();
        if (!response.ok) throw new Error(result.message || result.details || ('HTTP ' + response.status));
        return result[0];
    },

    async deleteLedgerEntry(id) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/ledger_entries?id=eq.${id}`, {
            method: 'DELETE',
            headers: wmsHeaders()
        });
        return response.ok;
    }
};

// Initialize - callable from app.html when module is loaded
function initMasterData() {
    DB.init();
    loadInvestors();
    loadBrokers();
    loadPreferences();
    loadSecuritiesStats();
    loadFOStats();
    
    // Restore last active tab if page was refreshed
    const savedTab = localStorage.getItem('wms_master_data_tab');
    if (savedTab && document.getElementById(`${savedTab}-tab`)) {
        // Deactivate default (investors) tab
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
        // Activate saved tab
        const tabBtn = document.querySelector(`.tab-btn[onclick*="${savedTab}"]`);
        if (tabBtn) tabBtn.classList.add('active');
        document.getElementById(`${savedTab}-tab`).classList.add('active');
        
        // Trigger tab-specific logic
        if (savedTab === 'securities') {
            if (!_secTableLoaded) { _secTableLoaded = true; loadSecuritiesTable(); }
            if (!_foTableLoaded) { _foTableLoaded = true; loadFOTable(); }
        }
        if (savedTab === 'preferences') {
            loadPreferences();
        }
        if (savedTab === 'charges') {
            if (!_chargesLoaded) { _chargesLoaded = true; loadChargesConfig(); }
        }
    }
}

// Also support direct page load
window.addEventListener('DOMContentLoaded', initMasterData);

// Tab switching
function switchTab(event, tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    // Save current tab for refresh persistence
    localStorage.setItem('wms_master_data_tab', tabName);
    
    if (tabName === 'securities') {
        loadSecuritiesStats();
        loadFOStats();
        if (!_secTableLoaded) { _secTableLoaded = true; loadSecuritiesTable(); }
        if (!_foTableLoaded) { _foTableLoaded = true; loadFOTable(); }
    }
    if (tabName === 'preferences') {
        loadPreferences();
    }
    if (tabName === 'charges') {
        if (!_chargesLoaded) { _chargesLoaded = true; loadChargesConfig(); }
    }
}

// INVESTORS
async function loadInvestors() {
    const investors = await DB.getInvestors();
    const brokers = await DB.getBrokers();
    const accounts = await DB.getAllBrokerAccounts();
    renderInvestors(investors, brokers, accounts);
}

function renderInvestors(investors, brokers, accounts) {
    const searchTerm = document.getElementById('investorSearch').value.toLowerCase();
    const filtered = investors.filter(i =>
        i.name.toLowerCase().includes(searchTerm) ||
        (i.email && i.email.toLowerCase().includes(searchTerm))
    );

    const grid = document.getElementById('investorsGrid');
    if (filtered.length === 0) {
        grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">👥</div><h3>No investors found</h3></div>';
        return;
    }

    grid.innerHTML = `
        <table class="data-table">
            <thead>
                <tr>
                    <th style="width:32px;"></th>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Type</th>
                    <th>Brokers</th>
                    <th>Status</th>
                    <th style="width:80px;text-align:center;">⋮</th>
                </tr>
            </thead>
            <tbody>
                ${filtered.map(inv => {
                    const initials = inv.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
                    const statusClass = inv.is_active ? 'status-active' : 'status-inactive';
                    const statusText  = inv.is_active ? 'Active' : 'Inactive';
                    const invAccounts = accounts.filter(acc => acc.investor_id === inv.id);
                    const mappedBrokers = invAccounts.map(acc => {
                        const broker = brokers.find(b => b.id === acc.broker_id);
                        return broker ? broker.name : 'Unknown';
                    });
                    return `
                        <tr>
                            <td><div class="avatar">${initials}</div></td>
                            <td><strong>${inv.name}</strong>${inv.short_name ? '<br><span style="font-size:10px;color:#718096;">(' + inv.short_name + ')</span>' : ''}</td>
                            <td style="color:#718096;">${inv.email || '—'}</td>
                            <td>${inv.account_type || '—'}</td>
                            <td>${mappedBrokers.length > 0 ? mappedBrokers.map(b => `<span class="broker-tag">${b}</span>`).join('') : '<span style="color:#718096;">—</span>'}</td>
                            <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                            <td style="text-align:center;white-space:nowrap;">
                                <button class="btn-icon" onclick="handleEditInvestor('${inv.id}')" title="Edit" style="display:inline-block;">✏️</button>
                                <button class="btn-icon" onclick="handleDeleteInvestor('${inv.id}')" title="Delete" style="display:inline-block;">🗑️</button>
                            </td>
                        </tr>`;
                }).join('')}
            </tbody>
        </table>`;
}

function filterInvestors() {
    loadInvestors();
}

// Global handlers
window.handleEditInvestor = function(id) {
    editInvestor(id);
};

window.handleDeleteInvestor = function(id) {
    confirmDeleteInvestor(id);
};

async function openAddInvestorModal() {
    editingInvestorId = null;
    document.getElementById('investorModalTitle').textContent = 'Add Investor';
    document.getElementById('investorForm').reset();
    document.getElementById('investorStatus').value = 'true';
    document.getElementById('investorAccountType').value = '';
    document.getElementById('investorInterestRate').value = '';
    document.getElementById('investorInterestFreq').value = '';
    document.getElementById('investorTaxRate').value = '';
    // Setup display formatting for investor-level interest rate + tax rate
    mdSetupRateInput(document.getElementById('investorInterestRate'), 'percent');
    mdSetupRateInput(document.getElementById('investorTaxRate'), 'percent');
    document.getElementById('brokerAccountsList').innerHTML = '';
    brokerAccountCounter = 0;
    // Accounting controls — default to not-in-accounting
    document.getElementById('investorBookMode').value = 'none';
    mdPopulateBookParents(null);
    document.getElementById('investorPostFno').checked = true;
    document.getElementById('investorSttExpense').checked = false;
    mdOnBookModeChange();
    document.getElementById('investorModal').classList.add('show');
}

async function editInvestor(id) {
    const investors = await DB.getInvestors();
    const investor = investors.find(i => i.id === id);
    if (!investor) return;

    editingInvestorId = id;
    document.getElementById('investorModalTitle').textContent = 'Edit Investor';
    document.getElementById('investorId').value = investor.id;
    document.getElementById('investorName').value = investor.name;
    document.getElementById('investorShortName').value = investor.short_name || '';
    document.getElementById('investorAccountType').value = investor.account_type || '';
    document.getElementById('investorEmail').value = investor.email || '';
    document.getElementById('investorPan').value = investor.pan || '';
    document.getElementById('investorPhone').value = investor.phone || '';
    document.getElementById('investorStatus').value = investor.is_active ? 'true' : 'false';
    var invTerms = investor.interest_terms;
    document.getElementById('investorInterestRate').value = (invTerms && invTerms.rate) ? invTerms.rate : '';
    document.getElementById('investorInterestFreq').value = (invTerms && invTerms.frequency) ? invTerms.frequency : '';
    document.getElementById('investorTaxRate').value = (investor.tax_rate && parseFloat(investor.tax_rate) > 0) ? investor.tax_rate : '';
    // Setup display formatting for investor-level interest rate + tax rate
    mdSetupRateInput(document.getElementById('investorInterestRate'), 'percent');
    mdSetupRateInput(document.getElementById('investorTaxRate'), 'percent');

    // Accounting controls
    var invBookMode = investor.accounting_enabled ? 'own' : (investor.book_parent_id ? 'client' : 'none');
    document.getElementById('investorBookMode').value = invBookMode;
    mdPopulateBookParents(investor.id);
    document.getElementById('investorBookParent').value = investor.book_parent_id || '';
    document.getElementById('investorPostFno').checked = investor.post_fno !== false;
    document.getElementById('investorSttExpense').checked = !!investor.stt_accounting_method;
    mdOnBookModeChange();

    const accounts = await DB.getBrokerAccounts(id);
    document.getElementById('brokerAccountsList').innerHTML = '';
    brokerAccountCounter = 0;
    for (const acc of accounts) {
        await addBrokerAccount(acc.broker_id, acc.account_number, acc.brokerage_rates, acc.charges_inclusive, acc);
    }

    document.getElementById('investorModal').classList.add('show');
}

// ---- Accounting (book) controls in the investor form ----
function mdPopulateBookParents(excludeId) {
    var sel = document.getElementById('investorBookParent');
    if (!sel) return;
    var list = (window.wmsRefData && wmsRefData.investors ? wmsRefData.investors : [])
        .filter(function (i) { return i.accounting_enabled && i.id !== excludeId; })
        .sort(function (a, b) { return (a.short_name || a.name).localeCompare(b.short_name || b.name); });
    sel.innerHTML = '<option value="">— select parent book —</option>' +
        list.map(function (i) { return '<option value="' + i.id + '">' + (i.short_name || i.name) + '</option>'; }).join('');
}
function mdOnBookModeChange() {
    var mode = document.getElementById('investorBookMode').value;
    document.getElementById('investorBookParentWrap').style.display = (mode === 'client') ? '' : 'none';
    // STT + F&O settings apply only to own-books investors; clients inherit the parent's
    document.getElementById('investorBookSettingsRow').style.display = (mode === 'own') ? '' : 'none';
    document.getElementById('investorClientNote').style.display = (mode === 'client') ? '' : 'none';
}
window.mdOnBookModeChange = mdOnBookModeChange;

// Rate input display formatting: shows "0.5%" on blur, raw "0.005" on focus
// mode: 'decimal' = stored as decimal proportion (0.005 = 0.5%), 'percent' = stored as % (18 = 18%)
function mdSetupRateInput(input, mode) {
    // Avoid stacking duplicate listeners
    if (input._rateFormatted) {
        // Just re-format the current value for display
        var cur = input.value.replace(/%/g, '').trim();
        if (cur && !isNaN(parseFloat(cur))) {
            input._rawValue = cur;
            var n = parseFloat(cur);
            if (mode === 'decimal') {
                input.value = parseFloat((n * 100).toPrecision(10)) + '%';
            } else {
                input.value = parseFloat(n.toPrecision(10)) + '%';
            }
        }
        return;
    }
    input._rateFormatted = true;
    function formatForDisplay(raw) {
        var num = parseFloat(raw);
        if (isNaN(num) || num === 0) return '';
        if (mode === 'decimal') {
            // 0.005 → "0.5%", 0.03 → "3%", 0.00075 → "0.075%"
            var pct = num * 100;
            // Remove trailing zeros: 0.500 → 0.5, 3.000 → 3
            return parseFloat(pct.toPrecision(10)) + '%';
        } else {
            // 18 → "18%", 10.5 → "10.5%"
            return parseFloat(num.toPrecision(10)) + '%';
        }
    }
    function rawValue(display) {
        if (!display) return '';
        // Strip % and any whitespace
        var s = String(display).replace(/%/g, '').trim();
        if (mode === 'decimal') {
            // User sees "0.5%" but we store 0.005 — the raw value IS the decimal, not the display %
            // So on focus we just strip the % format and show the raw decimal
        }
        return s;
    }
    input.addEventListener('focus', function() {
        // On focus: show raw editable value
        var val = input.value.replace(/%/g, '').trim();
        if (mode === 'decimal') {
            // Display currently shows "0.5%", we need to convert back to 0.005
            var num = parseFloat(val);
            if (!isNaN(num) && num !== 0) {
                input.value = num / 100;
            } else {
                input.value = input._rawValue || '';
            }
        } else {
            // Display shows "18%", raw is "18"
            input.value = val;
        }
        input.select();
    });
    input.addEventListener('blur', function() {
        var val = input.value.replace(/%/g, '').trim();
        var num = parseFloat(val);
        if (isNaN(num) || val === '') {
            input._rawValue = '';
            input.value = '';
            return;
        }
        input._rawValue = val;
        input.value = formatForDisplay(val);
    });
    // Initial display format if value exists
    var initVal = input.value.replace(/%/g, '').trim();
    if (initVal && !isNaN(parseFloat(initVal))) {
        input._rawValue = initVal;
        input.value = formatForDisplay(initVal);
    }
}

// Apply rate formatting to all rate inputs in a broker account card
function mdFormatBrokerRates(index) {
    // Brokerage rates: decimal proportion (0.005 = 0.5%)
    var decimalInputs = ['.eq-del-pct', '.eq-intra-pct', '.fut-pct'];
    decimalInputs.forEach(function(cls) {
        var el = document.querySelector(cls + '[data-index="' + index + '"]');
        if (el) mdSetupRateInput(el, 'decimal');
    });
    // Interest & margin: plain percentage (18 = 18%)
    var pctInputs = ['.iba-interest-rate', '.iba-margin-rate', '.iba-tax-rate'];
    pctInputs.forEach(function(cls) {
        var el = document.querySelector(cls + '[data-index="' + index + '"]');
        if (el) mdSetupRateInput(el, 'percent');
    });
}

async function addBrokerAccount(selectedBrokerId = '', accountNumber = '', existingRates = null, chargesInclusive = false, existingAcc = null) {
    const brokers = await DB.getBrokers();
    const index = brokerAccountCounter++;

    const selectedBroker = selectedBrokerId ? brokers.find(b => b.id === selectedBrokerId) : null;
    const rates = existingRates || (selectedBroker ? selectedBroker.default_brokerage_rates : {
        equity: { delivery: { pct: 0, max: 20 }, intraday: { pct: 0.03, max: 20 } },
        derivatives: { futures: { pct: 0.03, max: 20 }, options: { flat: 20, max: 0 } }
    });

    // Extract ledger fields from existing account (if editing)
    var ibaInterestTerms = (existingAcc && existingAcc.interest_terms) ? existingAcc.interest_terms : null;
    var ibaInterestRate = (ibaInterestTerms && ibaInterestTerms.rate) ? ibaInterestTerms.rate : '';
    var ibaIntFreq = (ibaInterestTerms && ibaInterestTerms.frequency) ? ibaInterestTerms.frequency : '';
    var ibaMarginRate = (existingAcc && existingAcc.margin_rate) ? existingAcc.margin_rate : '';
    var ibaTaxRate = (existingAcc && existingAcc.tax_rate) ? existingAcc.tax_rate : '';

    const html = `
        <div class="broker-account-item" id="broker-account-${index}">
            <div class="broker-account-header">
                <strong style="font-size:14px;">Broker Account ${index + 1}</strong>
                <button type="button" class="btn-remove" onclick="removeBrokerAccount(${index})">Remove</button>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Broker *</label>
                    <select class="broker-select" data-index="${index}" onchange="loadBrokerDefaults(${index})" required>
                        <option value="">Choose...</option>
                        ${brokers.map(b => `<option value="${b.id}" ${b.id === selectedBrokerId ? 'selected' : ''}>${b.name}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Account Number</label>
                    <input type="text" class="account-number" data-index="${index}" value="${accountNumber}" placeholder="Optional">
                </div>
            </div>
            <div class="brokerage-grid">
                <div class="form-group">
                    <label>Charges Inclusive?</label>
                    <select class="charges-inclusive" data-index="${index}">
                        <option value="false" ${!chargesInclusive ? 'selected' : ''}>No</option>
                        <option value="true" ${chargesInclusive ? 'selected' : ''}>Yes</option>
                    </select>
                </div>
                <div class="brokerage-section">
                    <span class="brokerage-label">Equity - Delivery</span>
                    <div class="form-row">
                        <div class="form-group"><label>Rate</label><input type="text" inputmode="decimal" class="eq-del-pct" data-index="${index}" value="${rates.equity?.delivery?.pct !== undefined ? rates.equity.delivery.pct : ''}" placeholder="e.g., 0.005 = 0.5%"></div>
                        <div class="form-group"><label>Max ₹ (0 = no cap)</label><input type="number" step="0.01" class="eq-del-max" data-index="${index}" value="${rates.equity?.delivery?.max !== undefined ? rates.equity.delivery.max : ''}"></div>
                    </div>
                </div>
                <div class="brokerage-section">
                    <span class="brokerage-label">Equity - Intraday</span>
                    <div class="form-row">
                        <div class="form-group"><label>Rate</label><input type="text" inputmode="decimal" class="eq-intra-pct" data-index="${index}" value="${rates.equity?.intraday?.pct !== undefined ? rates.equity.intraday.pct : ''}" placeholder="e.g., 0.03 = 3%"></div>
                        <div class="form-group"><label>Max ₹ (0 = no cap)</label><input type="number" step="0.01" class="eq-intra-max" data-index="${index}" value="${rates.equity?.intraday?.max !== undefined ? rates.equity.intraday.max : ''}"></div>
                    </div>
                </div>
                <div class="brokerage-section">
                    <span class="brokerage-label">Futures</span>
                    <div class="form-row">
                        <div class="form-group"><label>Rate</label><input type="text" inputmode="decimal" class="fut-pct" data-index="${index}" value="${rates.derivatives?.futures?.pct !== undefined ? rates.derivatives.futures.pct : ''}" placeholder="e.g., 0.03 = 3%"></div>
                        <div class="form-group"><label>Max ₹ (0 = no cap)</label><input type="number" step="0.01" class="fut-max" data-index="${index}" value="${rates.derivatives?.futures?.max !== undefined ? rates.derivatives.futures.max : ''}"></div>
                    </div>
                </div>
                <div class="brokerage-section">
                    <span class="brokerage-label">Options</span>
                    <div class="form-row">
                        <div class="form-group"><label>Flat ₹ per lot</label><input type="number" step="0.01" class="opt-flat" data-index="${index}" value="${rates.derivatives?.options?.flat !== undefined ? rates.derivatives.options.flat : ''}" placeholder="e.g., 20"></div>
                        <div class="form-group"><label>Max ₹ (0 = no cap)</label><input type="number" step="0.01" class="opt-max" data-index="${index}" value="${rates.derivatives?.options?.max !== undefined ? rates.derivatives.options.max : ''}"></div>
                    </div>
                </div>
            </div>
            <div class="brokerage-grid" style="margin-top:8px;border-top:1px solid #eee;padding-top:8px;">
                <div class="form-group" style="grid-column:1/-1;">
                    <span class="brokerage-label" style="font-weight:600;">Statement Settings</span>
                </div>
                <div class="brokerage-section">
                    <div class="form-row">
                        <div class="form-group"><label>Interest Rate p.a.</label><input type="text" inputmode="decimal" class="iba-interest-rate" data-index="${index}" value="${ibaInterestRate}" placeholder="e.g., 18 = 18%"></div>
                        <div class="form-group"><label>Interest Frequency</label>
                            <select class="iba-interest-freq" data-index="${index}">
                                <option value="" ${!ibaIntFreq ? 'selected' : ''}>Default (Weekly Friday)</option>
                                <option value="weekly_friday" ${ibaIntFreq === 'weekly_friday' ? 'selected' : ''}>Weekly Friday</option>
                                <option value="daily_monthly_compound" ${ibaIntFreq === 'daily_monthly_compound' ? 'selected' : ''}>Daily + Monthly Compound</option>
                                <option value="monthly" ${ibaIntFreq === 'monthly' ? 'selected' : ''}>Monthly</option>
                                <option value="quarterly" ${ibaIntFreq === 'quarterly' ? 'selected' : ''}>Quarterly</option>
                            </select>
                        </div>
                    </div>
                </div>
                <div class="brokerage-section">
                    <div class="form-row">
                        <div class="form-group"><label>Margin Rate</label><input type="text" inputmode="decimal" class="iba-margin-rate" data-index="${index}" value="${ibaMarginRate}" placeholder="e.g., 10 = 10%"></div>
                        <div class="form-group"><label>Tax Rate on Gains</label><input type="text" inputmode="decimal" class="iba-tax-rate" data-index="${index}" value="${ibaTaxRate}" placeholder="e.g., 12.5 = 12.5%"></div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.getElementById('brokerAccountsList').insertAdjacentHTML('beforeend', html);
    // Store existing acc data for preserving fields not in the form (cn_password, api_* etc.)
    if (existingAcc) {
        var el = document.getElementById('broker-account-' + index);
        if (el) el._existingAcc = existingAcc;
    }
    // Apply rate display formatting (shows "0.5%" on blur, raw value on focus)
    mdFormatBrokerRates(index);
}

async function loadBrokerDefaults(index) {
    const select = document.querySelector(`.broker-select[data-index="${index}"]`);
    const brokerId = select.value;
    if (!brokerId) return;
    
    const brokers = await DB.getBrokers();
    const broker = brokers.find(b => b.id === brokerId);
    if (!broker || !broker.default_brokerage_rates) return;
    
    const rates = broker.default_brokerage_rates;
    document.querySelector(`.eq-del-pct[data-index="${index}"]`).value = rates.equity?.delivery?.pct ?? '';
    document.querySelector(`.eq-del-max[data-index="${index}"]`).value = rates.equity?.delivery?.max ?? '';
    document.querySelector(`.eq-intra-pct[data-index="${index}"]`).value = rates.equity?.intraday?.pct ?? '';
    document.querySelector(`.eq-intra-max[data-index="${index}"]`).value = rates.equity?.intraday?.max ?? '';
    document.querySelector(`.fut-pct[data-index="${index}"]`).value = rates.derivatives?.futures?.pct ?? '';
    document.querySelector(`.fut-max[data-index="${index}"]`).value = rates.derivatives?.futures?.max ?? '';
    document.querySelector(`.opt-flat[data-index="${index}"]`).value = rates.derivatives?.options?.flat ?? '';
    document.querySelector(`.opt-max[data-index="${index}"]`).value = rates.derivatives?.options?.max ?? '';
    document.querySelector(`.charges-inclusive[data-index="${index}"]`).value = broker.default_charges_inclusive ? 'true' : 'false';
    // Re-apply rate display formatting after loading defaults
    mdFormatBrokerRates(index);
}

function removeBrokerAccount(index) {
    const element = document.getElementById(`broker-account-${index}`);
    if (element) element.remove();
}

// Helper: read numeric value from a rate input, stripping any "%" display suffix
function mdReadRate(el) {
    if (!el) return 0;
    var raw = el._rawValue !== undefined && el._rawValue !== '' ? el._rawValue : el.value;
    return parseFloat(String(raw).replace(/%/g, '').trim()) || 0;
}

async function saveInvestor() {
    var invIntRate = mdReadRate(document.getElementById('investorInterestRate'));
    var invIntFreq = document.getElementById('investorInterestFreq').value || '';
    var invInterestTerms = null;
    if (invIntRate > 0) {
        invInterestTerms = { rate: invIntRate, frequency: invIntFreq || 'weekly_friday', compound: (invIntFreq === 'daily_monthly_compound') };
    }
    var invBookMode = document.getElementById('investorBookMode').value;
    var invBookParent = document.getElementById('investorBookParent').value || null;
    var invPostFno = document.getElementById('investorPostFno').checked;
    var invSttExpense = document.getElementById('investorSttExpense').checked;
    // Clients inherit STT + F&O from their parent book; own-books use the form values.
    var parentBook = (invBookMode === 'client' && invBookParent && window.wmsRefData && wmsRefData.investors)
        ? wmsRefData.investors.find(function (i) { return i.id === invBookParent; }) : null;
    var effPostFno = (invBookMode === 'own') ? invPostFno : (parentBook ? (parentBook.post_fno !== false) : true);
    var effSttExpense = (invBookMode === 'own') ? invSttExpense : (parentBook ? !!parentBook.stt_accounting_method : false);

    const data = {
        name: document.getElementById('investorName').value.trim(),
        short_name: document.getElementById('investorShortName').value.trim() || null,
        account_type: document.getElementById('investorAccountType').value,
        email: document.getElementById('investorEmail').value.trim() || null,
        pan: document.getElementById('investorPan').value.trim().toUpperCase() || null,
        phone: document.getElementById('investorPhone').value.trim() || null,
        is_active: document.getElementById('investorStatus').value === 'true',
        interest_terms: invInterestTerms,
        tax_rate: mdReadRate(document.getElementById('investorTaxRate')),
        // Accounting (book) role — see WMS_Accounting_Module_Plan.md §3.0
        accounting_enabled: invBookMode === 'own',
        book_parent_id: invBookMode === 'client' ? invBookParent : null,
        post_fno: effPostFno,
        stt_accounting_method: effSttExpense
    };

    if (!data.name) {
        alert('Please enter investor name');
        return;
    }

    if (!data.account_type) {
        alert('Please select account type');
        return;
    }

    if (invBookMode === 'client' && !invBookParent) {
        alert('Pick the parent book this investor is a client of.');
        return;
    }

    const brokerSelects = document.querySelectorAll('.broker-select');
    const brokerAccounts = [];

    brokerSelects.forEach((select) => {
        if (select.value) {
            const i = select.getAttribute('data-index');
            var ibaIntRate = mdReadRate(document.querySelector(`.iba-interest-rate[data-index="${i}"]`));
            var ibaIntFreq = document.querySelector(`.iba-interest-freq[data-index="${i}"]`).value || '';
            var ibaMarginRate = mdReadRate(document.querySelector(`.iba-margin-rate[data-index="${i}"]`));
            var ibaTaxRate = mdReadRate(document.querySelector(`.iba-tax-rate[data-index="${i}"]`));
            var ibaInterestTerms = null;
            if (ibaIntRate > 0) {
                ibaInterestTerms = { rate: ibaIntRate, frequency: ibaIntFreq || 'weekly_friday', compound: (ibaIntFreq === 'daily_monthly_compound') };
            }
            // Preserve fields not in the form (cn_password, api_* columns) from existing record
            var existingAcc = null;
            var itemEl = document.getElementById('broker-account-' + i);
            if (itemEl && itemEl._existingAcc) existingAcc = itemEl._existingAcc;
            var accObj = {
                broker_id: select.value,
                account_number: document.querySelector(`.account-number[data-index="${i}"]`).value.trim() || null,
                brokerage_rates: {
                    equity: {
                        delivery: {
                            pct: mdReadRate(document.querySelector(`.eq-del-pct[data-index="${i}"]`)),
                            max: parseFloat(document.querySelector(`.eq-del-max[data-index="${i}"]`).value)
                        },
                        intraday: {
                            pct: mdReadRate(document.querySelector(`.eq-intra-pct[data-index="${i}"]`)),
                            max: parseFloat(document.querySelector(`.eq-intra-max[data-index="${i}"]`).value)
                        }
                    },
                    derivatives: {
                        futures: {
                            pct: mdReadRate(document.querySelector(`.fut-pct[data-index="${i}"]`)),
                            max: parseFloat(document.querySelector(`.fut-max[data-index="${i}"]`).value)
                        },
                        options: {
                            flat: parseFloat(document.querySelector(`.opt-flat[data-index="${i}"]`).value),
                            max: parseFloat(document.querySelector(`.opt-max[data-index="${i}"]`).value)
                        }
                    }
                },
                charges_inclusive: document.querySelector(`.charges-inclusive[data-index="${i}"]`).value === 'true',
                is_custom_rates: true,
                interest_terms: ibaInterestTerms,
                margin_rate: ibaMarginRate,
                tax_rate: ibaTaxRate
            };
            // Preserve columns not shown in form from existing record
            if (existingAcc) {
                if (existingAcc.cn_password) accObj.cn_password = existingAcc.cn_password;
                if (existingAcc.api_access_token) accObj.api_access_token = existingAcc.api_access_token;
                if (existingAcc.api_token_date) accObj.api_token_date = existingAcc.api_token_date;
                if (existingAcc.api_token_generated_at) accObj.api_token_generated_at = existingAcc.api_token_generated_at;
                if (existingAcc.api_token_method) accObj.api_token_method = existingAcc.api_token_method;
                if (existingAcc.api_auto_login) accObj.api_auto_login = existingAcc.api_auto_login;
                if (existingAcc.api_last_error) accObj.api_last_error = existingAcc.api_last_error;
                if (existingAcc.api_last_error_at) accObj.api_last_error_at = existingAcc.api_last_error_at;
            }
            brokerAccounts.push(accObj);
        }
    });

    try {
        let investorId;
        if (editingInvestorId) {
            await DB.updateInvestor(editingInvestorId, data);
            investorId = editingInvestorId;
        } else {
            const newInvestor = await DB.addInvestor(data);
            investorId = newInvestor.id;
        }
        
        await DB.saveBrokerAccounts(investorId, brokerAccounts);
        
        closeInvestorModal();
        loadInvestors();
        wmsLoadRefData(); // Refresh shared ref data after investor/IBA changes
    } catch (error) {
        console.error('Error saving investor:', error);
        alert('Error: ' + error.message);
    }
}

async function confirmDeleteInvestor(id) {
    const investors = await DB.getInvestors();
    const investor = investors.find(i => i.id === id);
    if (!investor) return;

    if (confirm(`Delete ${investor.name}?\n\nThis will also remove all associated broker accounts.`)) {
        try {
            const success = await DB.deleteInvestor(id);
            if (success) {
                // Also delete broker accounts
                await fetch(`${SUPABASE_URL}/rest/v1/investor_broker_accounts?investor_id=eq.${id}`, {
                    method: 'DELETE',
                    headers: wmsHeaders()
                });
                loadInvestors();
            }
        } catch (error) {
            console.error('Error deleting investor:', error);
            alert('Error: ' + error.message);
        }
    }
}

function closeInvestorModal() {
    document.getElementById('investorModal').classList.remove('show');
    editingInvestorId = null;
}

// BROKERS
async function loadBrokers() {
    const brokers = await DB.getBrokers();
    renderBrokers(brokers);
}

function renderBrokers(brokers) {
    const searchTerm = document.getElementById('brokerSearch').value.toLowerCase();
    const filtered = brokers.filter(b =>
        b.name.toLowerCase().includes(searchTerm) ||
        (b.broker_code && b.broker_code.toLowerCase().includes(searchTerm))
    );

    const grid = document.getElementById('brokersGrid');
    if (filtered.length === 0) {
        grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏦</div><h3>No brokers found</h3></div>';
        return;
    }

    grid.innerHTML = `
        <table class="data-table">
            <thead>
                <tr>
                    <th style="width:32px;"></th>
                    <th>Broker Name</th>
                    <th>Code</th>
                    <th>Website</th>
                    <th>Status</th>
                    <th style="width:80px;text-align:center;">⋮</th>
                </tr>
            </thead>
            <tbody>
                ${filtered.map(broker => {
                    const initials = broker.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
                    const statusClass = broker.is_active ? 'status-active' : 'status-inactive';
                    const statusText  = broker.is_active ? 'Active' : 'Inactive';
                    return `
                        <tr>
                            <td><div class="avatar">${initials}</div></td>
                            <td><strong>${broker.name}</strong></td>
                            <td style="color:#718096;">${broker.broker_code || '—'}</td>
                            <td>${broker.website ? `<a href="${broker.website}" target="_blank" style="color:#667eea;font-size:11px;">Visit ↗</a>` : '—'}</td>
                            <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                            <td style="text-align:center;white-space:nowrap;">
                                <button class="btn-icon" onclick="handleEditBroker('${broker.id}')" title="Edit" style="display:inline-block;">✏️</button>
                                <button class="btn-icon" onclick="handleDeleteBroker('${broker.id}')" title="Delete" style="display:inline-block;">🗑️</button>
                            </td>
                        </tr>`;
                }).join('')}
            </tbody>
        </table>`;
}

function filterBrokers() {
    loadBrokers();
}

// Global handlers
window.handleEditBroker = function(id) {
    editBroker(id);
};

window.handleDeleteBroker = function(id) {
    confirmDeleteBroker(id);
};

function openAddBrokerModal() {
    editingBrokerId = null;
    document.getElementById('brokerModalTitle').textContent = 'Add Broker';
    document.getElementById('brokerForm').reset();
    document.getElementById('brokerStatus').value = 'true';
    document.getElementById('chargesInclusive').value = 'false';
    document.getElementById('brokerCnParser').value = '';
    document.getElementById('brokerModal').classList.add('show');
}

async function editBroker(id) {
    const brokers = await DB.getBrokers();
    const broker = brokers.find(b => b.id === id);
    if (!broker) return;

    editingBrokerId = id;
    document.getElementById('brokerModalTitle').textContent = 'Edit Broker';
    document.getElementById('brokerId').value = broker.id;
    document.getElementById('brokerName').value = broker.name;
    document.getElementById('brokerCode').value = broker.broker_code || '';
    document.getElementById('brokerWebsite').value = broker.website || '';
    document.getElementById('brokerStatus').value = broker.is_active ? 'true' : 'false';
    
    const rates = broker.default_brokerage_rates || {};
    document.getElementById('eqDelPct').value = rates.equity?.delivery?.pct ?? '';
    document.getElementById('eqDelMax').value = rates.equity?.delivery?.max ?? '';
    document.getElementById('eqIntraPct').value = rates.equity?.intraday?.pct ?? '';
    document.getElementById('eqIntraMax').value = rates.equity?.intraday?.max ?? '';
    document.getElementById('futPct').value = rates.derivatives?.futures?.pct ?? '';
    document.getElementById('futMax').value = rates.derivatives?.futures?.max ?? '';
    document.getElementById('optFlat').value = rates.derivatives?.options?.flat ?? '';
    document.getElementById('optMax').value = rates.derivatives?.options?.max ?? '';
    document.getElementById('chargesInclusive').value = broker.default_charges_inclusive ? 'true' : 'false';
    document.getElementById('brokerCnParser').value = broker.cn_parser_template || '';

    document.getElementById('brokerModal').classList.add('show');
}

async function saveBroker() {
    const data = {
        name: document.getElementById('brokerName').value.trim(),
        broker_code: document.getElementById('brokerCode').value.trim().toUpperCase() || null,
        website: document.getElementById('brokerWebsite').value.trim() || null,
        is_active: document.getElementById('brokerStatus').value === 'true',
        default_brokerage_rates: {
            equity: {
                delivery: {
                    pct: parseFloat(document.getElementById('eqDelPct').value),
                    max: parseFloat(document.getElementById('eqDelMax').value)
                },
                intraday: {
                    pct: parseFloat(document.getElementById('eqIntraPct').value),
                    max: parseFloat(document.getElementById('eqIntraMax').value)
                }
            },
            derivatives: {
                futures: {
                    pct: parseFloat(document.getElementById('futPct').value),
                    max: parseFloat(document.getElementById('futMax').value)
                },
                options: {
                    flat: parseFloat(document.getElementById('optFlat').value),
                    max: parseFloat(document.getElementById('optMax').value)
                }
            }
        },
        default_charges_inclusive: document.getElementById('chargesInclusive').value === 'true',
        cn_parser_template: document.getElementById('brokerCnParser').value || null
    };

    if (!data.name) {
        alert('Please enter broker name');
        return;
    }

    try {
        if (editingBrokerId) {
            await DB.updateBroker(editingBrokerId, data);
        } else {
            await DB.addBroker(data);
        }
        closeBrokerModal();
        loadBrokers();
        wmsLoadRefData(); // Refresh shared ref data after broker changes
    } catch (error) {
        console.error('Error saving broker:', error);
        alert('Error: ' + error.message);
    }
}

async function confirmDeleteBroker(id) {
    const brokers = await DB.getBrokers();
    const broker = brokers.find(b => b.id === id);
    if (!broker) return;
    
    // Check if broker is mapped to any investors
    const accounts = await DB.getAllBrokerAccounts();
    const mappedAccounts = accounts.filter(acc => acc.broker_id === id);
    
    if (mappedAccounts.length > 0) {
        alert(`Cannot delete ${broker.name}!\n\nThis broker is mapped to ${mappedAccounts.length} investor account(s).\nPlease remove those mappings first.`);
        return;
    }

    if (confirm(`Delete ${broker.name}?`)) {
        try {
            const success = await DB.deleteBroker(id);
            if (success) {
                loadBrokers();
                loadInvestors();
            }
        } catch (error) {
            console.error('Error deleting broker:', error);
            alert('Error: ' + error.message);
        }
    }
}

function closeBrokerModal() {
    document.getElementById('brokerModal').classList.remove('show');
    editingBrokerId = null;
}

// PREFERENCES
async function loadPreferences() {
    const user = await DB.getUser();
    if (!user || !user.preferences) return;

    const prefs = user.preferences;
    document.getElementById('numberFormat').value = prefs.number_format || 'indian';
    document.getElementById('currencySymbol').value = prefs.currency_symbol || '₹';
    document.getElementById('dateFormat').value = prefs.date_format || 'dd-mmm-yy';
    document.getElementById('decimalPlaces').value = prefs.decimal_places || 2;
    document.getElementById('amountDisplay').value = prefs.amount_display || 'lakhs';
    document.getElementById('theme').value = prefs.theme || 'light';
    document.getElementById('defaultView').value = prefs.default_view || 'portfolio';
    document.getElementById('financialYearStart').value = prefs.financial_year_start || 4;
}

async function savePreferences() {
    const preferences = {
        number_format: document.getElementById('numberFormat').value,
        currency_symbol: document.getElementById('currencySymbol').value,
        date_format: document.getElementById('dateFormat').value,
        decimal_places: parseInt(document.getElementById('decimalPlaces').value),
        amount_display: document.getElementById('amountDisplay').value,
        theme: document.getElementById('theme').value,
        default_view: document.getElementById('defaultView').value,
        financial_year_start: parseInt(document.getElementById('financialYearStart').value)
    };

    try {
        await DB.updateUserPreferences(preferences);

        // Update in-memory user and localStorage so display updates immediately
        if (window.currentUser) {
            window.currentUser.preferences = { 
                ...window.currentUser.preferences, 
                ...preferences 
            };
            localStorage.setItem('wms_user', JSON.stringify(window.currentUser));
        }

        alert('✓ Preferences saved successfully!');
    } catch (error) {
        console.error('Error saving preferences:', error);
        alert('Error: ' + error.message);
    }
}

// Modal close on background click
document.getElementById('investorModal').addEventListener('click', e => {
    if (e.target.id === 'investorModal') closeInvestorModal();
});

document.getElementById('brokerModal').addEventListener('click', e => {
    if (e.target.id === 'brokerModal') closeBrokerModal();
});

// ═══════════════════════════════════════════════════════════════
// SECURITIES DB — Sync, Preview & Browse
// ═══════════════════════════════════════════════════════════════

// CSV column indices (NSE_CM.csv and BSE_CM.csv — 21 columns, no header)
var COL = { FYTOKEN:0, NAME:1, INSTR_TYPE:2, LOT_SIZE:3, TICK:4, ISIN:5,
              SESSION:6, LAST_UPDATE:7, EXPIRY:8, SYMBOL:9, EXCH_CODE:10,
              SEGMENT:11, SCRIPT_CODE:12, SHORT_SYM:13, UNDERLYING_CODE:14,
              STRIKE:15, OPT:16, UNDERLYING_TOKEN:17, RESERVED:18,
              EQUITY_FLAG:19, LOT_MULT:20 };

// Classification rules ─────────────────────────────────────────

function deriveSecurity(instrType, nseSeries, bseSeries, companyName) {
    const s = nseSeries || bseSeries || '';
    const i = parseInt(instrType);
    const n = (companyName || '').toUpperCase();

    // ── Series checks ALWAYS first — instr_type never overrides a known series ──

    // InvIT — NSE:-IV  BSE:-IN
    if (s === 'IV' || s === 'IN')       return { security_type: 'INVIT',      asset_class: 'Infrastructure' };

    // REIT — NSE:-RR is definitive
    //        BSE:-IF is ambiguous (also used for institutional bonds) — check name too
    if (s === 'RR')                      return { security_type: 'REIT',       asset_class: 'Real Estate' };
    if (s === 'IF') {
        if (/\bREIT\b/.test(n))          return { security_type: 'REIT',       asset_class: 'Real Estate' };
        else                              return { security_type: 'NCD',        asset_class: 'Debt' };
    }

    // SGB — NSE:-GB
    if (s === 'GB')                      return { security_type: 'SGB',        asset_class: 'Gold' };

    // Govt Bonds — NSE:-SG (SDL),-GS (GOI),-EG  BSE:-Q
    if (s === 'SG' || s === 'GS' || s === 'EG' || s === 'Q')
                                         return { security_type: 'GOVT_BOND',  asset_class: 'Debt' };

    // NCD / Debentures — NSE:-YL  BSE:-F,-X
    if (s === 'YL' || s === 'F' || s === 'X')
                                         return { security_type: 'NCD',        asset_class: 'Debt' };

    // Preference Shares — BSE:-P
    if (s === 'P')                       return { security_type: 'PREF_SHARE', asset_class: 'Indian Equity' };

    // Rights/Warrants — NSE:-RE,-W1,-W2  BSE:-W
    if (s === 'RE' || s === 'W' || s === 'W1' || s === 'W2')
                                         return { security_type: 'RIGHTS',     asset_class: 'Indian Equity' };

    // SME — NSE:-SM  BSE:-S
    if (s === 'SM' || s === 'S')         return { security_type: 'EQUITY_SME', asset_class: 'Indian Equity' };

    // ── instr_type for ETF vs closed-end MF (both use -MF/-M series) ──
    if (i === 9)                         return { security_type: 'ETF',        asset_class: null };
    if (i === 8)                         return { security_type: 'MF',         asset_class: null };

    // ── Name-based fallbacks — only when series gave no info ──
    if (/INVIT|INFRAVIT|INFRATRUST|INFRASTRUCTURE INV/.test(n))
                                         return { security_type: 'INVIT',      asset_class: 'Infrastructure' };
    if (/\bREIT\b/.test(n))              return { security_type: 'REIT',       asset_class: 'Real Estate' };

    // Default: EQUITY (EQ,BE,BZ,ST / A,T,B,Z)
    return { security_type: 'EQUITY', asset_class: 'Indian Equity' };
}

function deriveETFClass(name) {
    if (!name) return null;
    const n = name.toUpperCase();
    if (/GOLD/.test(n))                         return 'Gold';
    if (/SILVER/.test(n))                       return 'Silver';
    if (/NASDAQ|S&P|US |HANGSENG|GLOBAL/.test(n)) return 'International Equity';
    if (/LIQUID|OVERNIGHT|MONEY MARKET/.test(n)) return 'Cash Equivalent';
    if (/NIFTY|SENSEX|MIDCAP|SMALLCAP|BANKBEES|INFRABEES/.test(n)) return 'Indian Equity';
    if (/GILT|BOND|GSEC|DEBT/.test(n))          return 'Debt';
    return null; // will be flagged for manual review
}

// CSV parsing ──────────────────────────────────────────────────

function parseCSVLine(line) {
    // Simple split on comma — these CSVs have no quoted fields
    return line.split(',');
}

function extractSeries(fyersSymbol) {
    // "NSE:TATAMOTORS-EQ" → "EQ"   "BSE:360ONE-A" → "A"
    if (!fyersSymbol) return '';
    const parts = fyersSymbol.split('-');
    return parts[parts.length - 1] || '';
}

async function fetchAndParseCSV(url) {
    // CM version — filters out rows with no ISIN (equities always have one)
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
    const text = await resp.text();
    const rows = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const cols = parseCSVLine(t);
        if (cols.length < 14) continue;
        const isin = cols[COL.ISIN].trim();
        if (!isin || isin === '' || isin === 'None') continue;
        rows.push(cols);
    }
    return rows;
}

async function fetchAndParseCSVRaw(url) {
    // F&O version — no ISIN filter (F&O contracts never have ISINs)
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
    const text = await resp.text();
    const rows = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const cols = parseCSVLine(t);
        if (cols.length < 17) continue;   // F&O rows have 21 cols, need at least 17
        rows.push(cols);
    }
    return rows;
}

// Build merged record map (keyed by ISIN) ──────────────────────

function buildRecordMap(nseRows, bseRows) {
    const map        = new Map(); // isin → record
    const symbolSeen = new Map(); // symbol → isin (to detect cross-ISIN symbol collisions)

    function processRow(cols, exchange) {
        const isin        = cols[COL.ISIN].trim();
        const fyersSymbol = cols[COL.SYMBOL].trim();
        const series      = extractSeries(fyersSymbol);
        const shortSym    = cols[COL.SHORT_SYM].trim();
        const instrType   = parseInt(cols[COL.INSTR_TYPE]) || 0;
        const lotSize     = parseInt(cols[COL.LOT_SIZE]) || 1;
        const name        = cols[COL.NAME].trim();
        const scriptCode  = cols[COL.SCRIPT_CODE].trim();
        const fytoken     = cols[COL.FYTOKEN].trim();

        // Skip pure derivatives / options leftovers
        if (cols[COL.OPT] && cols[COL.OPT].trim() !== 'XX') return;
        if (cols[COL.EXPIRY] && cols[COL.EXPIRY].trim() !== '') return;
        if (!isin) return;

        if (!map.has(isin)) {
            map.set(isin, {
                isin, company_name: name, lot_size: lotSize,
                symbol: null, nse_symbol: null, nse_script_code: null,
                bse_symbol: null, bse_script_code: null,
                broker_tokens: { fyers: {} },
                nse_series: null, bse_series: null,
                fyers_instr_type: instrType,
                security_type: 'EQUITY', asset_class: 'Indian Equity',
                is_active: true
            });
        }
        const rec = map.get(isin);

        if (exchange === 'NSE') {
            rec.nse_symbol      = shortSym;
            rec.nse_script_code = scriptCode;
            rec.nse_series      = series;
            rec.broker_tokens.fyers.nse_token  = fytoken;
            rec.broker_tokens.fyers.nse_symbol = fyersSymbol;
            // Set canonical symbol from NSE (preferred)
            rec.symbol = shortSym;
        } else {
            rec.bse_symbol      = shortSym;
            rec.bse_script_code = scriptCode;
            rec.bse_series      = series;
            rec.broker_tokens.fyers.bse_token  = fytoken;
            rec.broker_tokens.fyers.bse_symbol = fyersSymbol;
            // Only use BSE short_sym as canonical if no NSE row exists yet
            if (!rec.symbol) rec.symbol = shortSym;
        }

        // Re-derive classification now that we might have both series
        const cls = deriveSecurity(instrType, rec.nse_series, rec.bse_series, rec.company_name);
        rec.security_type  = cls.security_type;
        rec.asset_class    = (rec.security_type === 'ETF')
            ? deriveETFClass(rec.company_name)
            : cls.asset_class;
        rec.fyers_instr_type = instrType;
    }

    for (const cols of nseRows) processRow(cols, 'NSE');
    for (const cols of bseRows) processRow(cols, 'BSE');

    // Resolve symbol collisions: two different ISINs claiming the same symbol
    // (happens with rights entitlements, warrants sharing a base symbol name)
    // Keep the first seen (NSE preferred); suffix the duplicate with its series
    for (const [isin, rec] of map) {
        const sym = rec.symbol;
        if (!sym) continue;
        if (!symbolSeen.has(sym)) {
            symbolSeen.set(sym, isin);
        } else {
            // Collision — suffix with series to make unique
            const series = rec.nse_series || rec.bse_series || 'X';
            let candidate = `${sym}-${series}`;
            if (symbolSeen.has(candidate)) candidate = `${sym}-${isin.slice(-4)}`;
            rec.symbol = candidate;
            symbolSeen.set(rec.symbol, isin);
        }
    }

    return map;
}

// State for sync session ───────────────────────────────────────

var _syncPending = null; // { toAdd:[], toUpdate:[], missing:[], unchanged:[] }
var _syncModalMode = null; // 'cm' or 'fo' — tracks which sync is active in the modal
var _syncActiveCard = null; // 'new' | 'edit' | 'miss' | null — which stat card is selected
var _syncPreviewData = null; // { toAdd:[], toUpdate:[], missing:[] } — unified data for card click rendering

// Compare two records for meaningful changes ───────────────────

var TRACKED_FIELDS = ['company_name','symbol','nse_symbol','nse_script_code',
    'bse_symbol','bse_script_code','lot_size',
    'nse_series','bse_series','fyers_instr_type'];
// NOTE: security_type and asset_class are excluded from TRACKED_FIELDS
// because they are manually curated and should not be overwritten by sync.

function diffRecord(existing, incoming) {
    const diffs = [];
    for (const f of TRACKED_FIELDS) {
        const a = existing[f] === undefined ? null : existing[f];
        const b = incoming[f]  === undefined ? null : incoming[f];
        if (String(a ?? '') !== String(b ?? '')) {
            diffs.push({ field: f, from: a, to: b });
        }
    }
    // broker_tokens diff — compare values, not key order
    const normTok = obj => {
        const f = (obj?.fyers) || {};
        return [f.nse_token||'', f.nse_symbol||'', f.bse_token||'', f.bse_symbol||''].join('|');
    };
    if (normTok(existing.broker_tokens) !== normTok(incoming.broker_tokens))
        diffs.push({ field: 'broker_tokens', from: '(json)', to: '(updated)' });
    return diffs;
}

// Thin wrapper — delegates to shared wmsFetchAllRows() in wms-shared.js
async function fetchAllRows(table, select, orderCol) {
    return wmsFetchAllRows(table, select, orderCol);
}

// ═══════════════════════════════════════════════════════════════
// Sync Modal helpers
// ═══════════════════════════════════════════════════════════════

function openSyncModal(title, missLabel) {
    var modal = document.getElementById('syncModal');
    document.getElementById('syncModalTitle').textContent = title;
    // Reset stats
    document.getElementById('pvNew').textContent = '0';
    document.getElementById('pvEdit').textContent = '0';
    document.getElementById('pvMiss').textContent = '0';
    document.getElementById('pvSame').textContent = '0';
    if (missLabel) document.getElementById('pvMissLbl').textContent = missLabel;
    else document.getElementById('pvMissLbl').textContent = 'In DB, Not in CSV';
    // Reset preview section + card states
    _syncActiveCard = null;
    _syncPreviewData = null;
    document.getElementById('syncPreviewSection').style.display = 'none';
    document.getElementById('syncPreviewTbody').innerHTML = '';
    document.querySelectorAll('.sync-stat-box').forEach(function(b) { b.classList.remove('active'); });
    // Reset progress
    document.getElementById('syncProgressWrap').style.display = 'none';
    document.getElementById('syncProgressBar').style.width = '0%';
    document.getElementById('syncProgressBar').style.background = '';
    document.getElementById('syncProgressLabel').style.display = 'none';
    document.getElementById('syncProgressLabel').style.color = '';
    // Reset commit button
    var commitBtn = document.getElementById('btnCommit');
    commitBtn.disabled = true;
    commitBtn.textContent = '✓ Commit to Database';
    // Show modal
    modal.classList.add('show');
    // ESC to close
    document.addEventListener('keydown', _syncModalEscHandler);
}

function closeSyncModal() {
    var modal = document.getElementById('syncModal');
    modal.classList.remove('show');
    document.removeEventListener('keydown', _syncModalEscHandler);
    // Delegate cancel to the right sync type
    if (_syncModalMode === 'cm') { _syncPending = null; }
    if (_syncModalMode === 'fo') { _foCsvMap = null; _foDbMap = null; }
    _syncModalMode = null;
    _syncActiveCard = null;
    _syncPreviewData = null;
}

function _syncModalEscHandler(e) {
    if (e.key === 'Escape') closeSyncModal();
}

// Wire commit button to the right function based on mode
function syncModalCommit() {
    if (_syncModalMode === 'cm') commitSync();
    else if (_syncModalMode === 'fo') commitFOSync();
}

// Main sync flow ───────────────────────────────────────────────

async function startSync() {
    const btn = document.getElementById('btnSync');
    const progWrap = document.getElementById('syncProgressWrap');
    const progBar  = document.getElementById('syncProgressBar');
    const progLbl  = document.getElementById('syncProgressLabel');

    btn.disabled = true;
    btn.textContent = '⏳ Fetching CSVs...';
    _syncModalMode = 'cm';
    openSyncModal('📋 CM Sync Preview — Review before committing');
    progWrap.style.display = 'block';
    progLbl.style.display  = 'block';
    progBar.style.width = '10%';
    progLbl.textContent = 'Downloading NSE_CM.csv...';

    try {
        const nseRows = await fetchAndParseCSV('https://public.fyers.in/sym_details/NSE_CM.csv');
        progBar.style.width = '35%';
        progLbl.textContent = 'Downloading BSE_CM.csv...';

        const bseRows = await fetchAndParseCSV('https://public.fyers.in/sym_details/BSE_CM.csv');
        progBar.style.width = '55%';
        progLbl.textContent = `Parsed ${nseRows.length + bseRows.length} rows. Loading DB...`;

        // Load ALL existing DB records (paginated — default limit is 1000)
        const existing = await fetchAllRows('securities_db', '*', 'isin');

        progBar.style.width = '70%';
        progLbl.textContent = 'Computing diff...';

        const csvMap = buildRecordMap(nseRows, bseRows);
        const dbMap  = new Map((existing || []).map(r => [r.isin, r]));

        const toAdd    = [];
        const toUpdate = [];
        const unchanged= [];

        for (const [isin, incoming] of csvMap) {
            if (!dbMap.has(isin)) {
                toAdd.push(incoming);
            } else {
                const ex = dbMap.get(isin);
                // Preserve manually curated classification fields from DB
                incoming.security_type = ex.security_type;
                incoming.asset_class   = ex.asset_class;
                const diffs = diffRecord(ex, incoming);
                if (diffs.length > 0) {
                    toUpdate.push({ record: incoming, diffs, existing: ex });
                } else {
                    unchanged.push(isin);
                }
            }
        }

        const missing = [...dbMap.keys()].filter(isin => !csvMap.has(isin))
            .map(isin => dbMap.get(isin));

        _syncPending = { toAdd, toUpdate, missing, unchanged };

        progBar.style.width = '100%';
        progLbl.textContent = 'Analysis complete.';
        setTimeout(() => { progWrap.style.display='none'; progLbl.style.display='none'; }, 800);

        renderSyncPreview(_syncPending);
        document.getElementById('btnCommit').disabled = (toAdd.length + toUpdate.length === 0);

    } catch (err) {
        progLbl.textContent = '❌ Error: ' + err.message;
        progBar.style.background = '#dc2626';
        console.error(err);
    } finally {
        btn.disabled = false;
        btn.textContent = '⟳ CM Sync';
    }
}

function renderSyncPreview({ toAdd, toUpdate, missing, unchanged }) {
    document.getElementById('pvNew').textContent  = toAdd.length.toLocaleString('en-IN');
    document.getElementById('pvEdit').textContent = toUpdate.length.toLocaleString('en-IN');
    document.getElementById('pvMiss').textContent = missing.length.toLocaleString('en-IN');
    document.getElementById('pvSame').textContent = (Array.isArray(unchanged) ? unchanged.length : unchanged).toLocaleString('en-IN');

    // Store data for card click rendering
    _syncPreviewData = { toAdd: toAdd, toUpdate: toUpdate, missing: missing };

    // Auto-select the first non-zero card: prefer edit, then new, then miss
    if (toUpdate.length > 0) syncCardClick('edit');
    else if (toAdd.length > 0) syncCardClick('new');
    else if (missing.length > 0) syncCardClick('miss');
}

// ── Sync card click handler (shared by CM and F&O) ──────────
function syncCardClick(card) {
    if (!_syncPreviewData) return;
    // Toggle: clicking active card deselects it
    if (_syncActiveCard === card) {
        _syncActiveCard = null;
        document.querySelectorAll('.sync-stat-box').forEach(function(b) { b.classList.remove('active'); });
        document.getElementById('syncPreviewSection').style.display = 'none';
        return;
    }
    _syncActiveCard = card;
    // Highlight active card
    document.querySelectorAll('.sync-stat-box').forEach(function(b) { b.classList.remove('active'); });
    var cardMap = { 'new': 'syncCardNew', 'edit': 'syncCardEdit', 'miss': 'syncCardMiss', 'same': 'syncCardSame' };
    var el = document.getElementById(cardMap[card]);
    if (el) el.classList.add('active');
    // Render the table for the selected card
    renderSyncCardTable(card);
}

function renderSyncCardTable(card) {
    var section = document.getElementById('syncPreviewSection');
    var title = document.getElementById('syncPreviewTitle');
    var thead = document.getElementById('syncPreviewThead');
    var tbody = document.getElementById('syncPreviewTbody');
    tbody.innerHTML = '';
    thead.innerHTML = '';

    if (_syncModalMode === 'cm') {
        renderSyncCardTableCM(card, title, thead, tbody);
    } else if (_syncModalMode === 'fo') {
        renderSyncCardTableFO(card, title, thead, tbody);
    }
    section.style.display = 'block';
}

function renderSyncCardTableCM(card, title, thead, tbody) {
    var d = _syncPreviewData;
    if (card === 'new') {
        title.textContent = d.toAdd.length + ' new securities to add';
        thead.innerHTML = '<tr><th>Symbol</th><th>ISIN</th><th>Company</th><th>Type</th><th>Exchange</th></tr>';
        d.toAdd.forEach(function(r) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td><strong>' + (r.symbol || '') + '</strong></td>' +
                '<td style="font-size:10px;color:#718096;">' + (r.isin || '') + '</td>' +
                '<td>' + (r.company_name || '') + '</td>' +
                '<td><span class="change-tag tag-new">' + (r.security_type || '') + '</span></td>' +
                '<td style="font-size:11px;color:#718096;">' + (r.nse_symbol ? 'NSE' : '') + (r.nse_symbol && r.bse_symbol ? ' / ' : '') + (r.bse_symbol ? 'BSE' : '') + '</td>';
            tbody.appendChild(tr);
        });
    } else if (card === 'edit') {
        title.textContent = d.toUpdate.length + ' securities will be updated';
        thead.innerHTML = '<tr><th>Symbol</th><th>ISIN</th><th>Field</th><th>Current Value</th><th>New Value</th></tr>';
        d.toUpdate.forEach(function(u) {
            u.diffs.forEach(function(diff) {
                var tr = document.createElement('tr');
                tr.innerHTML = '<td><strong>' + (u.record.symbol || '') + '</strong></td>' +
                    '<td style="font-size:10px;color:#718096;">' + (u.record.isin || '') + '</td>' +
                    '<td><span class="change-tag tag-edit">' + diff.field + '</span></td>' +
                    '<td style="color:#718096;font-size:11px;">' + (diff.from == null ? '—' : diff.from) + '</td>' +
                    '<td style="color:#2d3748;font-size:11px;">' + (diff.to == null ? '—' : diff.to) + '</td>';
                tbody.appendChild(tr);
            });
        });
    } else if (card === 'miss') {
        title.textContent = d.missing.length + ' in DB but not in CSV (kept as-is)';
        thead.innerHTML = '<tr><th>Symbol</th><th>ISIN</th><th>Company</th><th>Note</th></tr>';
        d.missing.forEach(function(r) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td>' + (r.symbol || '') + '</td>' +
                '<td style="font-size:10px;">' + (r.isin || '') + '</td>' +
                '<td>' + (r.company_name || '') + '</td>' +
                '<td style="color:#718096;font-size:10px;">No longer in CSV — kept as-is</td>';
            tbody.appendChild(tr);
        });
    }
}

function renderSyncCardTableFO(card, title, thead, tbody) {
    var d = _syncPreviewData;
    if (card === 'new') {
        title.textContent = d.toAdd.length + ' new contracts to add';
        thead.innerHTML = '<tr><th>Symbol</th><th>Underlying</th><th>Exchange</th><th>Type</th><th>Lot Size</th><th>Expiry</th></tr>';
        d.toAdd.forEach(function(r) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td><strong>' + (r.symbol || '') + '</strong></td>' +
                '<td>' + (r.underlying_symbol || '') + '</td>' +
                '<td>' + (r.exchange || '') + '</td>' +
                '<td><span class="change-tag tag-new">' + (r.instrument_type || '') + '</span></td>' +
                '<td style="text-align:right;">' + (r.lot_size || '') + '</td>' +
                '<td style="font-size:11px;color:#718096;">' + (r.expiry_date || '') + '</td>';
            tbody.appendChild(tr);
        });
    } else if (card === 'edit') {
        title.textContent = d.toUpdate.length + ' contracts will be updated';
        thead.innerHTML = '<tr><th>Symbol</th><th>Field</th><th>Current Value</th><th>New Value</th></tr>';
        d.toUpdate.forEach(function(u) {
            u.diffs.forEach(function(diff) {
                var tr = document.createElement('tr');
                tr.innerHTML = '<td><strong>' + (u.symbol || '') + '</strong></td>' +
                    '<td><span class="change-tag tag-edit">' + diff.field + '</span></td>' +
                    '<td style="color:#718096;font-size:11px;">' + (diff.from == null ? '—' : diff.from) + '</td>' +
                    '<td style="color:#2d3748;font-size:11px;">' + (diff.to == null ? '—' : diff.to) + '</td>';
                tbody.appendChild(tr);
            });
        });
    } else if (card === 'miss') {
        var missLabel = document.getElementById('pvMissLbl').textContent;
        title.textContent = d.missing.length + ' ' + missLabel.toLowerCase();
        thead.innerHTML = '<tr><th>Symbol</th><th>Underlying</th><th>Exchange</th><th>Expiry</th><th>Note</th></tr>';
        d.missing.forEach(function(r) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td>' + (r.symbol || '') + '</td>' +
                '<td>' + (r.underlying_symbol || '') + '</td>' +
                '<td>' + (r.exchange || '') + '</td>' +
                '<td style="font-size:11px;color:#718096;">' + (r.expiry_date || '') + '</td>' +
                '<td style="color:#718096;font-size:10px;">Will be deactivated</td>';
            tbody.appendChild(tr);
        });
    }
}
window.syncCardClick = syncCardClick;

async function commitSync() {
    if (!_syncPending) return;
    const { toAdd, toUpdate } = _syncPending;
    const btn = document.getElementById('btnCommit');
    btn.disabled = true;
    btn.textContent = '⏳ Committing...';

    try {
        const BATCH = 200;
        let done = 0;
        const total = toAdd.length + toUpdate.length;

        // Upsert new records in batches
        const all = [
            ...toAdd,
            ...toUpdate.map(u => u.record)
        ];
        for (let i = 0; i < all.length; i += BATCH) {
            const batch = all.slice(i, i + BATCH);
            const { error } = await window.supabaseClient
                .from('securities_db')
                .upsert(batch, { onConflict: 'isin' });
            if (error) throw error;
            done += batch.length;
            btn.textContent = `⏳ ${done}/${total}...`;
        }

        // Save last sync timestamp
        localStorage.setItem('wms_last_securities_sync', new Date().toISOString());

        // Post-commit: fetch sector for newly added equities
        var yahooMsg = '';
        if (toAdd.length > 0) {
            btn.textContent = '⏳ Fetching Yahoo data for new records...';
            try {
                var yahooCount = await postCommitYahooFetch(toAdd);
                if (yahooCount > 0) yahooMsg = ' | Yahoo data populated: ' + yahooCount;
            } catch (yahooErr) {
                console.warn('Post-commit Yahoo fetch error:', yahooErr);
            }
        }

        alert('✓ Done! Added: ' + toAdd.length + ' | Updated: ' + toUpdate.length + yahooMsg);
        _syncPending = null;
        closeSyncModal();
        await loadSecuritiesStats();
        await loadSecuritiesTable(true);

    } catch (err) {
        alert('❌ Commit failed: ' + err.message);
        console.error(err);
    } finally {
        btn.disabled = false;
        btn.textContent = '✓ Commit to Database';
    }
}

function cancelSync() {
    _syncPending = null;
    closeSyncModal();
}

// ═══════════════════════════════════════════════════════════════
// YAHOO FINANCE HELPERS — Sector Sync, Size Sync, CM Sync hook
// ═══════════════════════════════════════════════════════════════

// Derive Yahoo Finance symbol from securities_db record
// NSE equities: SYMBOL.NS, NSE SME: SYMBOL-SM.NS, BSE-only: SYMBOL.BO
function deriveYahooSymbol(rec) {
    if (rec.nse_symbol) {
        if (rec.security_type === 'EQUITY_SME') return rec.nse_symbol + '-SM.NS';
        return rec.nse_symbol + '.NS';
    }
    if (rec.bse_symbol) return rec.bse_symbol + '.BO';
    return null;
}

// Call Yahoo Finance edge function for a batch of Yahoo symbols (max 50)
async function callYahooFinance(yahooSymbols) {
    var resp = await fetch(SUPABASE_URL + '/functions/v1/yahoo-finance', {
        method: 'POST',
        headers: wmsEdgeHeaders({'Content-Type': 'application/json'}),
        body: JSON.stringify({ symbols: yahooSymbols })
    });
    if (!resp.ok) throw new Error('Yahoo Finance edge function returned ' + resp.status);
    return await resp.json();
}

// Market cap thresholds for Indian market (in INR)
// 1 Cr = 10,000,000
function deriveSizeFromMarketCap(marketCap) {
    if (!marketCap || marketCap <= 0) return null;
    if (marketCap > 750000000000)  return 'large-cap';    // > 75,000 Cr
    if (marketCap > 250000000000)  return 'mid-cap';      // 25,001 - 75,000 Cr
    if (marketCap > 10000000000)   return 'small-cap';    // 1,001 - 25,000 Cr
    return 'micro-cap';                                    // <= 1,000 Cr
}

// ── Yahoo Sync (unified: sector + size + 52-week high/low) ──
// Single function replaces startSectorSync, startSizeSync, startWeek52Sync.
// Yahoo edge function returns all fields in one call — no need for 3 passes.
//
// Scope (2026-05-06): only securities the user actually cares about — i.e.
// any security_id that appears in `transactions` OR `watchlist_items`. This
// brings the universe down from ~5-7k EQUITY+EQUITY_SME rows (15-30 min
// runtime) to typically ~100-300 rows (~1 min runtime). NFO/MCX security_ids
// from F&O trades or NFO watchlist items naturally don't match securities_db
// (they live in `securities_nfo`), so they're excluded with no extra logic.
// The existing `.in('security_type', ['EQUITY','EQUITY_SME'])` filter stays
// as the final defence (B.14.6).

// Returns an Array of distinct security_id values that appear in either
// `transactions` or `watchlist_items` (security_source='securities_db' only,
// so NFO/options-dynamic items are excluded). Designed to be a small set
// (~100-500 entries) — fast enough to fetch in 2 round-trips.
//
// Defensive UUID filter: a small number of legacy `watchlist_items` rows
// carry pre-UUID identifiers like '7' or '2578'. The transactions table is
// strictly UUID-typed at the DB so those can't land there, but old watchlist
// rows do. Non-UUID values are silently dropped — they couldn't match any
// `securities_db.id` row anyway, and including them in `.in('id', [...])`
// would make PostgREST reject the entire batch with `22P02 invalid input
// syntax for type uuid`.
async function _collectRelevantEquitySecurityIds() {
    var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    var ids = {};
    var addIfUuid = function(v) {
        if (v && UUID_RE.test(v)) ids[v] = true;
    };

    // ---- transactions: every distinct security_id ----
    // Including all security_types is safe: the .in('id', ...) filter on
    // securities_db will only match equity-table IDs. NFO/MCX IDs live in
    // securities_nfo and won't match. Pull only the column we need to keep
    // the response small even on long histories.
    var from = 0, BATCH = 1000;
    while (true) {
        var resp = await window.supabaseClient
            .from('transactions')
            .select('security_id')
            .not('security_id', 'is', null)
            .range(from, from + BATCH - 1);
        if (resp.error) throw resp.error;
        var rows = resp.data || [];
        for (var i = 0; i < rows.length; i++) addIfUuid(rows[i].security_id);
        if (rows.length < BATCH) break;
        from += BATCH;
    }

    // ---- watchlist_items: only securities_db items ----
    var wresp = await window.supabaseClient
        .from('watchlist_items')
        .select('security_id')
        .eq('security_source', 'securities_db')
        .not('security_id', 'is', null);
    if (wresp.error) throw wresp.error;
    var wrows = wresp.data || [];
    for (var j = 0; j < wrows.length; j++) addIfUuid(wrows[j].security_id);

    return Object.keys(ids);
}

async function startYahooSync() {
    var btn = document.getElementById('btnYahooSync');
    btn.disabled = true;
    btn.textContent = '⏳ Loading...';
    setSecLoading(true, 'Finding relevant securities...');

    try {
        // Collect IDs from transactions + watchlist_items (B.14.7 / 2026-05-06)
        var relevantIds = await _collectRelevantEquitySecurityIds();

        if (relevantIds.length === 0) {
            alert('No relevant equity securities found.\n\nYahoo Sync now runs only on securities that appear in your transactions or watchlist. Add some trades or watchlist entries first.');
            return;
        }

        setSecLoading(true, 'Found ' + relevantIds.length + ' relevant security id(s). Fetching from Supabase...');

        // Fetch securities_db rows for those ids. Existing filters preserved:
        //   is_active=true (skip merged/inactive)
        //   security_type IN ('EQUITY','EQUITY_SME') (Yahoo Sync is equity-only — B.14.6)
        // Chunk the .in('id', [...]) clause to keep URLs under PostgREST limits
        // (UUID ≈ 36 chars; 100 ids ≈ 3.6KB which is comfortably below ~8KB).
        var all = [];
        var ID_CHUNK = 100;
        for (var ci = 0; ci < relevantIds.length; ci += ID_CHUNK) {
            var idBatch = relevantIds.slice(ci, ci + ID_CHUNK);
            var result = await window.supabaseClient
                .from('securities_db')
                .select('id,isin,symbol,nse_symbol,bse_symbol,sector,size,security_type')
                .eq('is_active', true)
                .in('security_type', ['EQUITY', 'EQUITY_SME'])
                .in('id', idBatch);
            if (result.error) throw result.error;
            all = all.concat(result.data || []);
        }

        if (all.length === 0) {
            alert('No matching active equities for your transactions / watchlist.\n\n' +
                  '(' + relevantIds.length + ' security id(s) collected, but none matched ' +
                  'an active EQUITY/EQUITY_SME row — likely all are F&O / debt / etc.)');
            return;
        }

        setSecLoading(true, 'Found ' + all.length + ' equities. Fetching data from Yahoo Finance...');

        // Build yahoo symbol → record map
        var yahooMap = {};
        var symbols = [];
        for (var i = 0; i < all.length; i++) {
            var ySym = deriveYahooSymbol(all[i]);
            if (!ySym) continue;
            if (!yahooMap[ySym]) { yahooMap[ySym] = []; symbols.push(ySym); }
            yahooMap[ySym].push(all[i]);
        }

        // Call Yahoo Finance in batches of 30
        var YBATCH = 30;
        var updated = 0;
        var skipped = 0;
        var failed = 0;
        var now = new Date().toISOString();

        for (var b = 0; b < symbols.length; b += YBATCH) {
            var batch = symbols.slice(b, b + YBATCH);
            setSecLoading(true, 'Yahoo Sync... ' + Math.min(b + YBATCH, symbols.length) + '/' + symbols.length);

            try {
                var result = await callYahooFinance(batch);
                var results = result.results || {};

                for (var s = 0; s < batch.length; s++) {
                    var sym = batch[s];
                    var data = results[sym];
                    if (!data) { skipped++; continue; }

                    var recs = yahooMap[sym] || [];
                    for (var r = 0; r < recs.length; r++) {
                        var rec = recs[r];
                        var updateObj = {};

                        // Sector: only fill if currently null (don't overwrite manual entries)
                        if (data.sector && !rec.sector) {
                            updateObj.sector = data.sector;
                        }

                        // Size: always update from latest market cap
                        if (data.marketCap) {
                            var newSize = deriveSizeFromMarketCap(data.marketCap);
                            if (newSize) updateObj.size = newSize;
                        }

                        // 52-week high/low: always update if available
                        if (data.week52High && data.week52Low) {
                            updateObj.week_52_high = data.week52High;
                            updateObj.week_52_low = data.week52Low;
                            updateObj.week_52_updated_at = now;
                        }

                        // Single DB update per record
                        if (Object.keys(updateObj).length > 0) {
                            var upd = await window.supabaseClient
                                .from('securities_db')
                                .update(updateObj)
                                .eq('id', rec.id);
                            if (upd.error) { failed++; console.warn('Yahoo update failed for', rec.symbol, upd.error); }
                            else { updated++; }
                        } else {
                            skipped++;
                        }
                    }
                }
            } catch (batchErr) {
                console.warn('Yahoo batch failed:', batchErr);
                failed += batch.length;
            }
        }

        alert('Yahoo Sync complete!\nUpdated: ' + updated + ' | Skipped (no data): ' + skipped + (failed > 0 ? ' | Failed: ' + failed : ''));
        await loadSecuritiesStats();
        await loadSecuritiesTable(true);
        // Refresh the securities cache so Portfolio picks up new values
        await wmsLoadSecuritiesCm(0, {all: true});

    } catch (err) {
        alert('Yahoo Sync error: ' + err.message);
        console.error(err);
    } finally {
        btn.disabled = false;
        btn.textContent = '⟳ Yahoo Sync';
        setSecLoading(false);
    }
}

// ── Post-CM-Sync Yahoo fetch for newly added records ─────────
// Called after commitSync() completes successfully.
// Fetches sector + size + 52wk for newly added equities in one pass.

async function postCommitYahooFetch(newRecords) {
    // Filter to equities with NSE or BSE symbols
    var eligible = [];
    for (var i = 0; i < newRecords.length; i++) {
        var rec = newRecords[i];
        if (rec.security_type !== 'EQUITY' && rec.security_type !== 'EQUITY_SME') continue;
        var ySym = deriveYahooSymbol(rec);
        if (!ySym) continue;
        eligible.push({ rec: rec, yahooSymbol: ySym });
    }

    if (eligible.length === 0) return 0;

    var updated = 0;
    var YBATCH = 30;
    var now = new Date().toISOString();

    for (var b = 0; b < eligible.length; b += YBATCH) {
        var batch = eligible.slice(b, b + YBATCH);
        var symbols = batch.map(function(e) { return e.yahooSymbol; });

        try {
            var result = await callYahooFinance(symbols);
            var results = result.results || {};

            for (var s = 0; s < batch.length; s++) {
                var item = batch[s];
                var data = results[item.yahooSymbol];
                if (!data) continue;

                var updateObj = {};
                if (data.sector) updateObj.sector = data.sector;
                if (data.marketCap) {
                    var newSize = deriveSizeFromMarketCap(data.marketCap);
                    if (newSize) updateObj.size = newSize;
                }
                if (data.week52High && data.week52Low) {
                    updateObj.week_52_high = data.week52High;
                    updateObj.week_52_low = data.week52Low;
                    updateObj.week_52_updated_at = now;
                }

                if (Object.keys(updateObj).length > 0) {
                    await window.supabaseClient
                        .from('securities_db')
                        .update(updateObj)
                        .eq('isin', item.rec.isin);
                    updated++;
                }
            }
        } catch (err) {
            console.warn('Post-commit Yahoo fetch batch failed:', err);
        }
    }

    return updated;
}

// Browse / filter table ────────────────────────────────────────

// _securitiesAll / _foAll removed — now read from wmsRefData.securitiesCm / securitiesNfo

async function loadSecuritiesStats() {
    try {
        const { count: total } = await window.supabaseClient
            .from('securities_db').select('*', { count: 'exact', head: true });
        const { count: active } = await window.supabaseClient
            .from('securities_db').select('*', { count: 'exact', head: true })
            .eq('is_active', true);
        document.getElementById('statTotal').textContent  = (total  || 0).toLocaleString('en-IN');
        document.getElementById('statActive').textContent = (active || 0).toLocaleString('en-IN');

        // Show date + time — prefer localStorage (set at commit time), fall back to DB max updated_at
        let syncTs = localStorage.getItem('wms_last_securities_sync');
        if (!syncTs && total > 0) {
            // DB has data but localStorage was cleared — read latest updated_at from DB
            const { data: latest } = await window.supabaseClient
                .from('securities_db').select('updated_at').order('updated_at', { ascending: false }).limit(1);
            if (latest && latest[0]) syncTs = latest[0].updated_at;
        }
        document.getElementById('statLastSync').textContent = syncTs
            ? new Date(syncTs).toLocaleString('en-IN', {
                day: 'numeric', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false })
            : 'Never';
    } catch(e) { console.warn('Stats load error', e); }
}

function setSecLoading(on, msg) {
    const overlay = document.getElementById('secLoadingOverlay');
    const msgEl   = document.getElementById('secLoadingMsg');
    const btnSync = document.getElementById('btnSync');
    const btnExport = document.getElementById('btnExport');
    if (!overlay) return;
    overlay.classList.toggle('visible', on);
    if (msgEl && msg) msgEl.textContent = msg;
    if (btnSync)  btnSync.disabled  = on;
    if (btnExport) btnExport.disabled = on;
}

async function loadSecuritiesTable(forceRefresh) {
    var tbody = document.getElementById('secTbody');
    setSecLoading(true, 'Loading securities...');
    try {
        // Use shared cache — force refresh after sync, else use cached data
        if (forceRefresh || !wmsRefData.securitiesCmReady) {
            await wmsLoadSecuritiesCm(0, {all: true});
        }
        populateTypePills();
        populateAssetClassPills();
        populateExchangePills();
        populateSizePills();
        populateSectorPills();
        renderSecurities();
    } catch(e) {
        console.warn('Securities table load error', e);
        if (tbody) tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#718096;padding:20px;">Connect to Supabase to browse securities</td></tr>';
    } finally {
        setSecLoading(false);
    }
}

// renderSecurities kept as alias for pill filter changes triggered before unified is wired
function renderSecurities() { renderUnified(); }

// Populate type filter pills dynamically from loaded data
function populateTypePills() {
    var container = document.getElementById('msTypePills');
    if (!container) return;
    var types = new Set();
    var cmData = wmsRefData.securitiesCm || [];
    for (var i = 0; i < cmData.length; i++) {
        var t = cmData[i].security_type;
        if (t) types.add(t);
    }
    // Also add NFO types
    var nfoData = wmsRefData.securitiesNfo || [];
    for (var j = 0; j < nfoData.length; j++) {
        var it = nfoData[j].instrument_type;
        if (it) types.add(it);
    }
    var selected = getMsValues('msType');
    var sorted = Array.from(types).sort();
    container.innerHTML = sorted.map(function(t) {
        var isOn = selected.has(t) ? ' on' : '';
        return '<span class="ms-pill' + isOn + '" data-ms="msType" data-val="' + t + '" onclick="togglePill(this)">' + t + '</span>';
    }).join('');
}

// Populate asset class filter pills dynamically from loaded data
function populateAssetClassPills() {
    var container = document.getElementById('msClassPills');
    if (!container) return;
    var classes = new Set();
    var cmData = wmsRefData.securitiesCm || [];
    for (var i = 0; i < cmData.length; i++) {
        var c = cmData[i].asset_class;
        if (c) classes.add(c);
    }
    // NFO: derive asset class from exchange
    var nfoData = wmsRefData.securitiesNfo || [];
    for (var j = 0; j < nfoData.length; j++) {
        var exch = nfoData[j].exchange;
        if (exch === 'MCX') classes.add('Commodity');
        else classes.add('Indian Equity');
    }
    var selected = getMsValues('msClass');
    var sorted = Array.from(classes).sort();
    container.innerHTML = sorted.map(function(c) {
        var isOn = selected.has(c) ? ' on' : '';
        return '<span class="ms-pill' + isOn + '" data-ms="msClass" data-val="' + c + '" onclick="togglePill(this)">' + c + '</span>';
    }).join('');
}

// Populate exchange filter pills dynamically from loaded data
function populateExchangePills() {
    var container = document.getElementById('msExchPills');
    if (!container) return;
    var exchanges = new Set();
    var cmData = wmsRefData.securitiesCm || [];
    for (var i = 0; i < cmData.length; i++) {
        if (cmData[i].nse_symbol) exchanges.add('NSE');
        if (cmData[i].bse_symbol) exchanges.add('BSE');
    }
    var nfoData = wmsRefData.securitiesNfo || [];
    for (var j = 0; j < nfoData.length; j++) {
        var exch = nfoData[j].exchange;
        if (exch) exchanges.add(exch);
    }
    var selected = getMsValues('msExch');
    var sorted = Array.from(exchanges).sort();
    container.innerHTML = sorted.map(function(e) {
        var isOn = selected.has(e) ? ' on' : '';
        return '<span class="ms-pill' + isOn + '" data-ms="msExch" data-val="' + e + '" onclick="togglePill(this)">' + e + '</span>';
    }).join('');
}

// Populate size filter pills dynamically from loaded data
function populateSizePills() {
    var container = document.getElementById('msSizePills');
    if (!container) return;
    var sizes = new Set();
    var cmData = wmsRefData.securitiesCm || [];
    for (var i = 0; i < cmData.length; i++) {
        var s = cmData[i].size;
        if (s) sizes.add(s);
    }
    var selected = getMsValues('msSize');
    // Custom sort order for market cap sizes
    var order = ['large-cap', 'mid-cap', 'small-cap', 'micro-cap'];
    var sorted = Array.from(sizes).sort(function(a, b) {
        var ai = order.indexOf(a);
        var bi = order.indexOf(b);
        if (ai === -1) ai = 999;
        if (bi === -1) bi = 999;
        return ai - bi;
    });
    container.innerHTML = sorted.map(function(s) {
        var isOn = selected.has(s) ? ' on' : '';
        return '<span class="ms-pill' + isOn + '" data-ms="msSize" data-val="' + s + '" onclick="togglePill(this)">' + s + '</span>';
    }).join('');
}

// Populate sector filter pills dynamically from loaded data
var _allSectors = [];

function populateSectorPills() {
    var container = document.getElementById('msSectorPills');
    if (!container) return;
    var sectors = new Set();
    var cmData = wmsRefData.securitiesCm || [];
    for (var i = 0; i < cmData.length; i++) {
        var s = cmData[i].sector;
        if (s) sectors.add(s);
    }
    _allSectors = Array.from(sectors).sort();
    filterSectorPills();
}

function filterSectorPills() {
    var container = document.getElementById('msSectorPills');
    if (!container) return;
    var searchEl = document.getElementById('msSectorSearch');
    var q = (searchEl ? searchEl.value : '').toLowerCase().trim();
    var selected = getMsValues('msSector');

    var filtered = q ? _allSectors.filter(function(s) { return s.toLowerCase().indexOf(q) >= 0; }) : _allSectors;
    container.innerHTML = filtered.map(function(s) {
        var isOn = selected.has(s) ? ' on' : '';
        return '<span class="ms-pill' + isOn + '" data-ms="msSector" data-val="' + s + '" onclick="toggleSectorPill(this)">' + s + '</span>';
    }).join('');

    renderSectorSelectedTags();
}

function toggleSectorPill(pill) {
    pill.classList.toggle('on');
    updateMsLabel('msSector');
    renderSectorSelectedTags();
    renderUnified();
}

function renderSectorSelectedTags() {
    var container = document.getElementById('msSectorSelected');
    if (!container) return;
    var selected = getMsValues('msSector');
    if (selected.size === 0) { container.innerHTML = ''; container.style.display = 'none'; return; }
    container.style.display = 'flex';
    container.innerHTML = Array.from(selected).map(function(s) {
        return '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;background:#667eea;color:white;border-radius:12px;font-size:10px;font-weight:600;">' +
            s + ' <span onclick="removeSectorTag(\'' + s.replace(/'/g, "\\'") + '\')" style="cursor:pointer;margin-left:2px;">✕</span></span>';
    }).join('');
}

function removeSectorTag(val) {
    var pills = document.querySelectorAll('#msSectorPills .ms-pill');
    for (var i = 0; i < pills.length; i++) {
        if (pills[i].dataset.val === val && pills[i].classList.contains('on')) {
            pills[i].classList.remove('on');
        }
    }
    updateMsLabel('msSector');
    renderSectorSelectedTags();
    renderUnified();
}

// Pagination state for unified table
var _uniRows = [];   // full filtered result set
var _uniPage = 0;    // current page (0-indexed)
// PAGE_SIZE inlined as 100 in functions below

function _typeBadge(t) {
    const colors = {
        EQUITY:'#c6f6d5:#22543d', EQUITY_SME:'#bee3f8:#2c5282',
        ETF:'#e9d8fd:#553c9a',    MF:'#e9d8fd:#553c9a',
        SGB:'#fefcbf:#744210',    REIT:'#fed7d7:#822727',
        INVIT:'#ffe4c4:#7b341e',  GOVT_BOND:'#e2e8f0:#4a5568',
        NCD:'#e2e8f0:#4a5568',    PREF_SHARE:'#c6f6d5:#22543d',
        RIGHTS:'#fce8e8:#822727', WARRANT:'#fce8e8:#822727',
        FUTURES:'#fef3c7:#78350f', OPTIONS:'#dbeafe:#1e40af',
        PRIVATE_EQUITY:'#f3e8ff:#7c3aed'
    };
    const [bg, fg] = (colors[t]||'#e2e8f0:#4a5568').split(':');
    return `<span style="background:${bg};color:${fg};padding:1px 7px;border-radius:10px;font-size:10px;font-weight:600;">${t}</span>`;
}

function renderUnified(resetPage) {
    if (resetPage !== false) _uniPage = 0;  // any new filter/search resets to page 1
    const tbody  = document.getElementById('secTbody');
    if (!tbody) return;
    const q       = (document.getElementById('secSearch')?.value || '').trim().toLowerCase();
    
    // Debug logging
    if (q) console.log('[renderUnified] Search:', q, '| CM rows:', (wmsRefData.securitiesCm||[]).length, '| FO rows:', (wmsRefData.securitiesNfo||[]).length);
    const fTypes  = getMsValues('msType');
    const fExch   = getMsValues('msExch');
    const fClass  = getMsValues('msClass');
    const fSector = getMsValues('msSector');
    const fSize   = getMsValues('msSize');

    // Require at least a search term OR at least one filter to render
    const hasFilter = q.length >= 1 || fTypes.size > 0 || fExch.size > 0 || fClass.size > 0 || fSector.size > 0 || fSize.size > 0;
    if (!hasFilter) {
        _uniRows = [];
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#a0aec0;padding:32px;font-size:12px;">' +
            'Search above, or select a Type, Asset Class or Exchange filter to browse</td></tr>';
        renderUniPager(0, 0);
        return;
    }

    // Build unified row list from both datasets
    const cmRows = (wmsRefData.securitiesCm || []).map(r => ({
        _id:         r.id,
        symbol:      r.symbol || '',
        name:        r.company_name || '',
        type:        r.security_type || '',
        asset_class: r.asset_class || '',
        sector:      r.sector || '',
        size:        r.size || '',
        underlying:  '',
        expiry_dt:   null,
        lot_size:    r.lot_size || '',
        exchanges:   (r.nse_symbol ? 'NSE' : '') + (r.nse_symbol && r.bse_symbol ? ' ' : '') + (r.bse_symbol ? 'BSE' : ''),
        is_active:   r.is_active,
        isin:        r.isin || '',
        nse_symbol:  r.nse_symbol || '',
        bse_symbol:  r.bse_symbol || '',
        _src:        'cm'
    }));

    const foRows = (wmsRefData.securitiesNfo || []).map(r => ({
        symbol:      r.symbol || '',
        name:        r.instrument_name || '',
        type:        r.instrument_type || '',
        asset_class: r.exchange === 'MCX' ? 'Commodity' : 'Indian Equity',
        sector:      '',
        size:        '',
        underlying:  r.underlying_symbol || '',
        expiry_dt:   r.expiry_date ? new Date(r.expiry_date) : null,
        lot_size:    r.lot_size || '',
        exchanges:   r.exchange || '',
        is_active:   r.is_active,
        isin:        '',
        strike_price: r.strike_price ? String(r.strike_price) : '',
        option_type: r.option_type || '',
        expiry_date_str: r.expiry_date || '',
        _src:        'fo'
    }));

    let rows = [...cmRows, ...foRows];

    if (q) {
        var tokens = wmsTokenize(q);
        rows = rows.filter(function(r) {
            // CM: symbol, name, isin, nse_symbol, bse_symbol
            // NFO: symbol, name, underlying, exchange, expiry_date, strike_price, option_type
            return wmsMultiTokenMatch(tokens, r.symbol, r.name, r.isin,
                r.nse_symbol, r.bse_symbol, r.underlying,
                r.exchanges, r.expiry_date_str, r.strike_price, r.option_type);
        });
    }

    if (fTypes.size) rows = rows.filter(r => fTypes.has(r.type));

    if (fExch.size) rows = rows.filter(r => {
        if (r._src === 'cm') {
            return (fExch.has('NSE') && r.exchanges.includes('NSE')) ||
                   (fExch.has('BSE') && r.exchanges.includes('BSE'));
        }
        return fExch.has(r.exchanges);
    });

    if (fClass.size) rows = rows.filter(r => fClass.has(r.asset_class));
    if (fSector.size) rows = rows.filter(r => r.sector && fSector.has(r.sector));
    if (fSize.size) rows = rows.filter(r => r.size && fSize.has(r.size));

    // Sort: EQ first, then FUTURES, then OPTIONS; F&O sorted by expiry asc, inactive last
    var _typeOrder = { 'cm': 0, 'FUTURES': 1, 'OPTIONS': 2 };
    rows.sort(function(a, b) {
        // Group order: CM(0) < FUTURES(1) < OPTIONS(2)
        var aOrd = a._src === 'cm' ? 0 : (_typeOrder[a.type] || 1);
        var bOrd = b._src === 'cm' ? 0 : (_typeOrder[b.type] || 1);
        if (aOrd !== bOrd) return aOrd - bOrd;

        // Within CM: alphabetical by symbol
        if (a._src === 'cm' && b._src === 'cm') {
            return a.symbol.toUpperCase() < b.symbol.toUpperCase() ? -1 :
                   (a.symbol.toUpperCase() > b.symbol.toUpperCase() ? 1 : 0);
        }

        // Within same F&O type: inactive last
        var aInactive = a.is_active ? 0 : 1;
        var bInactive = b.is_active ? 0 : 1;
        if (aInactive !== bInactive) return aInactive - bInactive;

        // Then by expiry date ascending
        var aExp = a.expiry_dt ? a.expiry_dt.toISOString().slice(0, 10) : '';
        var bExp = b.expiry_dt ? b.expiry_dt.toISOString().slice(0, 10) : '';
        if (aExp !== bExp) return aExp < bExp ? -1 : (aExp > bExp ? 1 : 0);

        return a.symbol.toUpperCase() < b.symbol.toUpperCase() ? -1 :
               (a.symbol.toUpperCase() > b.symbol.toUpperCase() ? 1 : 0);
    });

    _uniRows = rows;

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#718096;padding:24px;font-size:12px;">No results found</td></tr>';
        renderUniPager(0, 0);
        return;
    }

    // Render current page
    const start = _uniPage * 100;
    const page  = rows.slice(start, start + 100);
    const today = new Date();

    tbody.innerHTML = page.map(r => {
        const expired    = r.expiry_dt && r.expiry_dt < today;
        const expiryStr  = r.expiry_dt
            ? r.expiry_dt.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'2-digit' })
            : '<span style="color:#cbd5e0;">—</span>';
        const expiryCol  = r.expiry_dt ? (expired ? 'color:#dc2626;' : 'color:#059669;') : '';
        var isUserDefined = r.isin && (r.isin.startsWith('PE-') || r.isin.startsWith('RE-'));
        var udColor = r.isin && r.isin.startsWith('RE-') ? '#2563eb' : '#9333ea';
        var symCell = isUserDefined
            ? '<td><strong style="font-size:12px;"><a href="#" onclick="openEditPeSecurityModal(\'' + r._id + '\');return false;" style="color:' + udColor + ';text-decoration:none;" title="Edit user-defined security">' + r.symbol + ' ✎</a></strong></td>'
            : '<td><strong style="font-size:12px;">' + r.symbol + '</strong></td>';
        var trAttr = r._src === 'cm' && r._id
            ? '<tr data-secid="' + r._id + '" style="cursor:pointer;" title="Double-click to view details">'
            : '<tr>';
        return trAttr +
            symCell +
            '<td style="font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + r.name + '</td>' +
            (r._src === 'cm'
                ? '<td class="sec-inline-edit" data-field="security_type" data-secid="' + r._id + '" style="cursor:pointer;" title="Double-click to edit">' + _typeBadge(r.type) + '</td>'
                : '<td>' + _typeBadge(r.type) + '</td>') +
            (r._src === 'cm'
                ? '<td class="sec-inline-edit" data-field="asset_class" data-secid="' + r._id + '" style="font-size:11px;color:#4a5568;cursor:pointer;" title="Double-click to edit">' + (r.asset_class || '<span style="color:#cbd5e0;">—</span>') + '</td>'
                : '<td style="font-size:11px;color:#4a5568;">' + (r.asset_class || '<span style="color:#cbd5e0;">—</span>') + '</td>') +
            (r._src === 'cm'
                ? '<td class="sec-inline-edit" data-field="sector" data-secid="' + r._id + '" style="font-size:11px;color:#4a5568;cursor:pointer;" title="Double-click to edit">' + (r.sector || '<span style="color:#cbd5e0;">—</span>') + '</td>'
                : '<td style="font-size:11px;color:#4a5568;">' + (r.sector || '<span style="color:#cbd5e0;">—</span>') + '</td>') +
            '<td style="font-size:11px;color:#4a5568;">' + (r.size || '<span style="color:#cbd5e0;">—</span>') + '</td>' +
            '<td style="font-size:11px;font-weight:600;">' + (r.underlying || '<span style="color:#cbd5e0;">—</span>') + '</td>' +
            '<td style="font-size:11px;' + expiryCol + '">' + expiryStr + '</td>' +
            '<td style="font-size:11px;text-align:right;">' + (r.lot_size || '<span style="color:#cbd5e0;">—</span>') + '</td>' +
            '<td style="font-size:11px;">' + r.exchanges + '</td>' +
            '<td><span class="status-badge ' + (r.is_active ? 'status-active' : 'status-inactive') + '">' +
                (r.is_active ? 'Active' : 'Inactive') + '</span></td>' +
            '</tr>';
    }).join('');

    renderUniPager(rows.length, page.length);
}

function renderUniPager(total, shown) {
    const bar = document.getElementById('uniPager');
    if (!bar) return;
    if (total === 0) { bar.innerHTML = ''; return; }
    const totalPages = Math.ceil(total / 100);
    const cur = _uniPage + 1;
    const from = (_uniPage * 100 + 1).toLocaleString('en-IN');
    const to   = Math.min((_uniPage + 1) * 100, total).toLocaleString('en-IN');
    bar.innerHTML =
        '<span style="font-size:11px;color:#718096;">Showing ' + from + '–' + to +
        ' of <strong>' + total.toLocaleString('en-IN') + '</strong> results</span>' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
            '<button class="page-btn" onclick="uniPageStep(-1)" ' + (cur <= 1 ? 'disabled' : '') + '>← Prev</button>' +
            '<span style="font-size:11px;color:#4a5568;">Page ' + cur + ' of ' + totalPages + '</span>' +
            '<button class="page-btn" onclick="uniPageStep(1)" ' + (cur >= totalPages ? 'disabled' : '') + '>Next →</button>' +
        '</div>';
}

function uniPageStep(delta) {
    const totalPages = Math.ceil(_uniRows.length / 100);
    _uniPage = Math.max(0, Math.min(_uniPage + delta, totalPages - 1));
    renderUnified(false);  // false = don't reset page
    // Scroll table back to top
    const wrap = document.getElementById('unifiedTableWrap');
    if (wrap) wrap.scrollTop = 0;
}

// Shared row renderer


function renderRows(rows, tbody) {
    if (!rows || !rows.length) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#718096;padding:20px;">No securities found</td></tr>';
        return;
    }
    const LIMIT = 500;
    tbody.innerHTML = rows.slice(0, LIMIT).map(r => `
        <tr>
            <td><strong style="font-size:12px;">${r.symbol||''}</strong></td>
            <td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.company_name||''}</td>
            <td>${_typeBadge(r.security_type||'')}</td>
            <td style="font-size:11px;color:#4a5568;">${r.asset_class||'<span style="color:#cbd5e0">—</span>'}</td>
            <td style="font-size:11px;">${r.nse_symbol ? '✓' : '—'}</td>
            <td style="font-size:11px;">${r.bse_symbol ? '✓' : '—'}</td>
            <td><span class="status-badge ${r.is_active?'status-active':'status-inactive'}">${r.is_active?'Active':'Inactive'}</span></td>
        </tr>`).join('');
    if (rows.length > LIMIT) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="11" style="text-align:center;font-size:11px;color:#718096;padding:8px;">
            Showing first ${LIMIT} of ${rows.length.toLocaleString('en-IN')} results — use filters to narrow down</td>`;
        tbody.appendChild(tr);
    }
}

// ═══════════════════════════════════════════════════════════════
// EXCEL EXPORT
// ═══════════════════════════════════════════════════════════════

async function exportSecuritiesExcel() {
    setSecLoading(true, 'Preparing export...');
    try {
        // Fetch full data including all columns not in browse view
        const rows = await fetchAllRows('securities_db',
            'symbol,company_name,isin,nse_symbol,nse_script_code,bse_symbol,bse_script_code,' +
            'lot_size,security_type,asset_class,nse_series,bse_series,fyers_instr_type,' +
            'size,sector,is_active,broker_tokens,updated_at', 'isin');

        // Build CSV content
        const headers = [
            'symbol','company_name','isin',
            'nse_symbol','nse_script_code','bse_symbol','bse_script_code',
            'lot_size','security_type','asset_class',
            'nse_series','bse_series','fyers_instr_type',
            'size','sector','is_active',
            'fyers_nse_token','fyers_nse_symbol','fyers_bse_token','fyers_bse_symbol',
            'updated_at'
        ];

        const csvRows = [headers.join(',')];
        for (const r of rows) {
            const bt = r.broker_tokens?.fyers || {};
            const cols = [
                csv(r.symbol),        csv(r.company_name),  csv(r.isin),
                csv(r.nse_symbol),    csv(r.nse_script_code), csv(r.bse_symbol), csv(r.bse_script_code),
                r.lot_size ?? '',     csv(r.security_type), csv(r.asset_class),
                csv(r.nse_series),    csv(r.bse_series),    r.fyers_instr_type ?? '',
                csv(r.size),          csv(r.sector),        r.is_active ? 'TRUE' : 'FALSE',
                csv(bt.nse_token),    csv(bt.nse_symbol),   csv(bt.bse_token), csv(bt.bse_symbol),
                csv(r.updated_at)
            ];
            csvRows.push(cols.join(','));
        }

        // Trigger download
        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = 'securities_db_' + new Date().toISOString().slice(0,10) + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch(e) {
        console.error('Export failed', e);
        alert('Export failed: ' + e.message);
    } finally {
        setSecLoading(false);
    }
}

// ═══════════════════════════════════════════════════════════════
// CLASSIFICATION IMPORT — Bulk update security_type & asset_class from Excel
// ═══════════════════════════════════════════════════════════════

async function importClassification(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    input.value = ''; // reset so same file can be re-selected

    setSecLoading(true, 'Reading Excel file...');
    try {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

        if (!rows.length) { alert('No data found in file.'); return; }

        // Validate required columns
        const sample = rows[0];
        if (!('isin' in sample)) {
            alert('Missing required column: isin\nThe Excel must have columns: isin, security_type, asset_class');
            return;
        }
        const hasType  = 'security_type' in sample;
        const hasClass = 'asset_class' in sample;
        if (!hasType && !hasClass) {
            alert('Excel must have at least one of: security_type, asset_class');
            return;
        }

        // Build update map keyed by ISIN
        const updates = [];
        let skipped = 0;
        for (const r of rows) {
            const isin = (r.isin || '').trim();
            if (!isin) { skipped++; continue; }
            const upd = {};
            if (hasType  && r.security_type != null) upd.security_type = String(r.security_type).trim();
            if (hasClass && r.asset_class   != null) upd.asset_class   = String(r.asset_class).trim();
            if (Object.keys(upd).length === 0) { skipped++; continue; }
            upd.isin = isin;
            updates.push(upd);
        }

        if (!updates.length) { alert('No valid rows to update.'); return; }

        const msg = `Found ${updates.length} records to update` +
            (skipped ? ` (${skipped} skipped)` : '') +
            `.\n\nFields: ${[hasType ? 'security_type' : '', hasClass ? 'asset_class' : ''].filter(Boolean).join(', ')}` +
            `\n\nProceed with update?`;
        if (!confirm(msg)) return;

        // Update each record by ISIN (cannot use upsert — partial columns hit NOT NULL constraints)
        // Use sequential processing to avoid Supabase rate limits (see A.2.2)
        const BATCH = 10;
        let done = 0;
        let failedIsins = [];
        for (let i = 0; i < updates.length; i += BATCH) {
            const batch = updates.slice(i, i + BATCH);
            const results = await Promise.all(batch.map(async upd => {
                const isin = upd.isin;
                const fields = { ...upd };
                delete fields.isin;
                const res = await window.supabaseClient
                    .from('securities_db')
                    .update(fields)
                    .eq('isin', isin);
                return { isin, fields, ...res };
            }));
            for (const r of results) {
                if (r.error) failedIsins.push(r);
            }
            done += batch.length;
            setSecLoading(true, `Updating... ${done}/${updates.length}`);
        }

        // Retry failed records one at a time with delay
        if (failedIsins.length > 0) {
            setSecLoading(true, `Retrying ${failedIsins.length} failed records...`);
            const stillFailed = [];
            for (const item of failedIsins) {
                await new Promise(r => setTimeout(r, 200)); // 200ms delay between retries
                const { error } = await window.supabaseClient
                    .from('securities_db')
                    .update(item.fields)
                    .eq('isin', item.isin);
                if (error) {
                    stillFailed.push(item.isin);
                    console.warn('Retry failed for ISIN ' + item.isin + ':', JSON.stringify(error));
                }
            }
            failedIsins = stillFailed;
        }

        const failed = failedIsins.length;
        alert(`✓ Classification updated for ${updates.length - failed} records.` + (failed ? ` (${failed} still failed: ${failedIsins.join(', ')})` : ''));
        await loadSecuritiesTable(true);

    } catch (e) {
        console.error('Classification import failed', e);
        alert('Import failed: ' + e.message);
    } finally {
        setSecLoading(false);
    }
}

// CSV cell escaper — wraps in quotes if value contains comma, quote or newline
function csv(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n'))
        return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

// Load table when securities tab is first opened
var _secTableLoaded = false;

// ═══════════════════════════════════════════════════════════════
// PILL-TOGGLE MULTI-SELECT HELPERS
// ═══════════════════════════════════════════════════════════════

// Returns a Set of currently selected values for a given ms id
function getMsValues(id) {
    const dd = document.getElementById(id + 'Dropdown');
    if (!dd) return new Set();
    return new Set([...dd.querySelectorAll('.ms-pill.on')].map(p => p.dataset.val));
}

// Toggle a pill on/off, update label, re-filter
function togglePill(pill) {
    pill.classList.toggle('on');
    updateMsLabel(pill.dataset.ms);
    renderUnified();
}

// Update the trigger button label to reflect selection state
function updateMsLabel(id) {
    const values  = getMsValues(id);
    const label   = document.getElementById(id + 'Label');
    const trigger = document.getElementById(id + 'Trigger');
    if (!label) return;
    const placeholders = { msType: 'All Types', msClass: 'All Asset Classes', msExch: 'All Exchanges', msSector: 'All Sectors', msSize: 'All Sizes' };
    const multiLabels  = { msType: 'types', msClass: 'classes', msExch: 'exchanges', msSector: 'sectors', msSize: 'sizes' };
    const placeholder  = placeholders[id] || 'All';
    if (values.size === 0) {
        label.textContent = placeholder;
        trigger.classList.remove('active');
    } else if (values.size === 1) {
        const pill = document.querySelector('#' + id + 'Dropdown .ms-pill.on');
        label.textContent = pill ? pill.textContent : [...values][0];
        trigger.classList.add('active');
    } else {
        label.textContent = values.size + ' ' + (multiLabels[id] || 'selected');
        trigger.classList.add('active');
    }
}

// Clear all pills for a given ms id
function clearMs(id) {
    const dd = document.getElementById(id + 'Dropdown');
    if (!dd) return;
    dd.querySelectorAll('.ms-pill.on').forEach(p => p.classList.remove('on'));
    updateMsLabel(id);
    renderUnified();
}

// Open/close the pill dropdown panel
function toggleMs(id) {
    const trigger  = document.getElementById(id + 'Trigger');
    const dropdown = document.getElementById(id + 'Dropdown');
    const isOpen   = dropdown.classList.contains('open');
    // Close all first
    document.querySelectorAll('.ms-dropdown.open').forEach(d => d.classList.remove('open'));
    document.querySelectorAll('.ms-trigger.open').forEach(t => t.classList.remove('open'));
    if (!isOpen) {
        dropdown.classList.add('open');
        trigger.classList.add('open');
    }
}

// Close when clicking outside — ensure single listener
if (!window._msClickHandlerAttached) {
    window._msClickHandlerAttached = true;
    document.addEventListener('click', e => {
        if (!e.target.closest('.ms-wrap')) {
            document.querySelectorAll('.ms-dropdown.open').forEach(d => d.classList.remove('open'));
            document.querySelectorAll('.ms-trigger.open').forEach(t => t.classList.remove('open'));
        }
    });
}

// switchSecSubTab removed — unified table used instead

// ═══════════════════════════════════════════════════════════════
// F&O STATS + TABLE
// ═══════════════════════════════════════════════════════════════

var _foTableLoaded = false;

async function loadFOStats() {
    try {
        const { count: total } = await window.supabaseClient
            .from('securities_nfo').select('*', { count: 'exact', head: true });
        const { count: active } = await window.supabaseClient
            .from('securities_nfo').select('*', { count: 'exact', head: true })
            .eq('is_active', true);
        document.getElementById('foStatTotal').textContent  = (total  || 0).toLocaleString('en-IN');
        document.getElementById('foStatActive').textContent = (active || 0).toLocaleString('en-IN');

        let syncTs = localStorage.getItem('wms_last_fo_sync');
        if (!syncTs && total > 0) {
            const { data: latest } = await window.supabaseClient
                .from('securities_nfo').select('updated_at')
                .order('updated_at', { ascending: false }).limit(1);
            if (latest && latest[0]) syncTs = latest[0].updated_at;
        }
        document.getElementById('foStatLastSync').textContent = syncTs
            ? new Date(syncTs).toLocaleString('en-IN', {
                day: 'numeric', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false })
            : 'Never';
    } catch(e) { console.warn('FO stats error', e); }
}

async function loadFOTable() {
    setSecLoading(true, 'Loading F&O contracts...');
    try {
        if (!wmsRefData.securitiesNfoReady) {
            await wmsLoadSecuritiesNfo();
        }
        renderUnified();
    } catch(e) {
        console.warn('FO table load error', e);
        var foTb = document.getElementById('foTbody');
        if (foTb) foTb.innerHTML =
            '<tr><td colspan="8" style="text-align:center;color:#718096;padding:20px;">Could not load F&O contracts</td></tr>';
    } finally {
        setSecLoading(false);
    }
}

// renderFO removed — renderUnified handles both CM and FO

// ═══════════════════════════════════════════════════════════════
// F&O SYNC  — NSE_FO.csv + MCX_COM.csv  (FUTURES only)
// ═══════════════════════════════════════════════════════════════

var _foCsvMap   = null;   // Map<symbol, record> built from CSV
var _foDbMap    = null;   // Map<symbol, record> from DB
var _foToAdd    = [];
var _foToUpdate = [];
var _foToDeactivate = [];

function setFOLoading(on, msg) {
    const overlay  = document.getElementById('secLoadingOverlay');
    const msgEl    = document.getElementById('secLoadingMsg');
    const btnFO    = document.getElementById('btnFOSync');
    const btnFOEx  = document.getElementById('btnFOExport');
    if (overlay) overlay.classList.toggle('visible', on);
    if (msgEl && msg) msgEl.textContent = msg;
    if (btnFO)   btnFO.disabled   = on;
    if (btnFOEx) btnFOEx.disabled = on;
}

async function startFOSync() {
    setFOLoading(true, 'Downloading F&O data...');
    _syncModalMode = 'fo';
    openSyncModal('📋 F&O Sync Preview — Review before committing', 'Expired (deactivated)');
    const progWrap = document.getElementById('syncProgressWrap');
    const progBar  = document.getElementById('syncProgressBar');
    const progLbl  = document.getElementById('syncProgressLabel');
    progWrap.style.display = 'block';
    progLbl.style.display  = 'block';
    progBar.style.width    = '5%';
    progLbl.textContent    = 'Downloading NSE_FO.csv...';

    try {
        // ── 1. Download & parse both CSVs ──────────────────────────
        const nseRows = await fetchAndParseCSVRaw('https://public.fyers.in/sym_details/NSE_FO.csv');
        progBar.style.width = '30%';
        progLbl.textContent = 'Downloading MCX_COM.csv...';

        const mcxRows = await fetchAndParseCSVRaw('https://public.fyers.in/sym_details/MCX_COM.csv');
        progBar.style.width = '55%';
        progLbl.textContent = 'Parsing contracts...';

        const today = new Date(); today.setHours(0,0,0,0);

        // ── 2. Parse BOTH futures (XX) AND options (CE/PE) ──────────
        // Options were historically skipped which meant every option record in
        // the DB got deactivated every run and expiry_date was never refreshed.
        // Now we parse all three but restrict CSV "add"s to futures only (the
        // options universe is enormous; new options are created lazily by CN /
        // Excel import). For existing options the sync updates expiry, lot size,
        // is_active, broker_tokens from Fyers' authoritative data.
        //
        // NORMALIZATION: we key by the BARE (prefix-stripped) symbol on both
        // sides. That lets a DB record created before we standardised the
        // NSE: prefix (bare "360ONE26MAY1100CE") be matched against the current
        // Fyers row ("NSE:360ONE26MAY1100CE") and be renamed + corrected.
        function _bareSym(s) { return (s || '').replace(/^[A-Z]+:/, ''); }

        function parseRow(cols, exchCode) {
            if (!cols || cols.length < 17) return null;
            const optTypeRaw = (cols[16] || '').trim();
            let instrumentType;
            if (optTypeRaw === 'XX') {
                instrumentType = 'FUTURES';
            } else if (optTypeRaw === 'CE' || optTypeRaw === 'PE') {
                instrumentType = 'OPTIONS';
            } else {
                return null; // ignore anything else
            }

            const symbol    = (cols[9]  || '').trim();
            const exEpoch   = parseInt(cols[8]);
            const exDate    = isNaN(exEpoch) ? null
                            : new Date(exEpoch * 1000).toISOString().slice(0, 10);
            const isActive  = exDate ? (new Date(exDate) >= today) : false;

            // IMPORTANT: we do NOT read strike_price or option_type from the CSV —
            // these fields were set correctly at record-create time (parseNfoSymbol
            // derives them from the symbol itself, which Fyers guarantees is
            // canonical). Reading them from unverified CSV column indices risked
            // silent data corruption if the column layout differs from what we
            // assume. By omitting them from the CSV record entirely they stay out
            // of the diff and the DB value is preserved.
            return {
                symbol,
                instrument_name:   (cols[1]  || '').trim(),
                exchange:          exchCode,
                instrument_type:   instrumentType,
                underlying_symbol: (cols[13] || '').trim(),
                expiry_date:       exDate,
                lot_size:          parseInt(cols[3]) || 1,
                trading_session:   (cols[6]  || '').trim(),
                is_active:         isActive,
                broker_tokens:     { fyers: { token: (cols[0] || '').trim(), symbol } }
            };
        }

        const csvRecords = [];
        for (const row of nseRows) {
            const r = parseRow(row, 'NSE');
            if (r && r.symbol) csvRecords.push(r);
        }
        for (const row of mcxRows) {
            const r = parseRow(row, 'MCX');
            if (r && r.symbol) csvRecords.push(r);
        }

        // CSV map keyed by bare (prefix-stripped) symbol so we can match
        // pre-standardisation DB records that were created without the NSE: prefix.
        _foCsvMap = new Map(csvRecords.map(r => [_bareSym(r.symbol), r]));

        progBar.style.width = '70%';
        progLbl.textContent = 'Loading DB...';

        // ── 3. Load existing DB ─────────────────────────────────────
        const existing = await fetchAllRows('securities_nfo', '*');
        _foDbMap = new Map(existing.map(r => [_bareSym(r.symbol), r]));

        progBar.style.width = '88%';
        progLbl.textContent = 'Computing diff...';

        // ── 4. Diff ─────────────────────────────────────────────────
        _foToAdd       = [];
        _foToUpdate    = [];
        _foToDeactivate = [];

        // For CSV records: ADD only if FUTURES and not in DB. UPDATE existing
        // (futures + options) when fields differ.
        for (const [bareKey, csv] of _foCsvMap) {
            const db = _foDbMap.get(bareKey);
            if (!db) {
                // Options are not added on sync — they're created lazily by
                // CN/Excel import when a trade arrives. Syncing every option
                // strike is impractical (tens of thousands per run).
                if (csv.instrument_type === 'FUTURES') _foToAdd.push(csv);
                continue;
            }
            const diffs = diffFORecord(db, csv);
            if (diffs.length) {
                // Carry the existing id through so the upsert updates rather
                // than duplicates, even when the symbol field itself changed
                // (bare → NSE:-prefixed).
                _foToUpdate.push({
                    symbol: csv.symbol,
                    diffs,
                    record: Object.assign({}, csv, { id: db.id })
                });
            }
        }

        // DEACTIVATION POLICY: only deactivate records whose expiry_date has
        // actually passed. Previously, any DB record not present in the CSV
        // (e.g., options since they weren't parsed) was flipped to inactive on
        // every sync, which marked the entire options book as dead.
        for (const [bareKey, db] of _foDbMap) {
            if (!db.is_active) continue;
            const expPassed = db.expiry_date && db.expiry_date < today.toISOString().slice(0,10);
            if (expPassed) _foToDeactivate.push(db);
        }

        progBar.style.width = '100%';
        progLbl.textContent = 'Done.';

        // ── 5. Show preview (using shared card-click pattern) ──────
        var unchangedCount = _foCsvMap.size - _foToAdd.length - _foToUpdate.length;
        renderSyncPreview({
            toAdd: _foToAdd,
            toUpdate: _foToUpdate,
            missing: _foToDeactivate,
            unchanged: unchangedCount
        });

        document.getElementById('btnCommit').disabled =
            (_foToAdd.length + _foToUpdate.length + _foToDeactivate.length === 0);

        progWrap.style.display = 'none';
        progLbl.style.display  = 'none';

    } catch(e) {
        console.error('FO sync error', e);
        progLbl.textContent = 'Error: ' + e.message;
        progLbl.style.color = '#dc2626';
    } finally {
        setFOLoading(false);
    }
}

function diffFORecord(db, csv) {
    const diffs = [];
    const check = (field, a, b) => {
        const av = a == null ? '' : String(a);
        const bv = b == null ? '' : String(b);
        if (av !== bv) diffs.push({ field, from: av, to: bv });
    };
    // `symbol` is included in the diff so pre-standardisation bare-symbol
    // records (e.g. '360ONE26MAY1100CE') get renamed to Fyers' canonical
    // prefixed form ('NSE:360ONE26MAY1100CE') on sync.
    // NOTE: strike_price and option_type are deliberately NOT checked here —
    // see the comment in parseRow. They stay frozen at the value set by
    // parseNfoSymbol at record-create time.
    check('symbol',            db.symbol,             csv.symbol);
    check('instrument_name',   db.instrument_name,    csv.instrument_name);
    check('instrument_type',   db.instrument_type,    csv.instrument_type);
    check('underlying_symbol', db.underlying_symbol,  csv.underlying_symbol);
    check('lot_size',          db.lot_size,           csv.lot_size);
    check('expiry_date',       db.expiry_date,        csv.expiry_date);
    check('is_active',         db.is_active,          csv.is_active);
    // broker token: compare fytoken value
    const dbTok  = db.broker_tokens?.fyers?.token  || '';
    const csvTok = csv.broker_tokens?.fyers?.token || '';
    if (dbTok !== csvTok) diffs.push({ field: 'broker_tokens', from: '(token)', to: '(updated)' });
    return diffs;
}

async function commitFOSync() {
    const btn = document.getElementById('btnCommit');
    btn.disabled = true;
    btn.textContent = '⏳ Committing...';
    setFOLoading(true, 'Committing F&O contracts...');

    const progWrap = document.getElementById('syncProgressWrap');
    const progBar  = document.getElementById('syncProgressBar');
    const progLbl  = document.getElementById('syncProgressLabel');
    progWrap.style.display = 'block';
    progLbl.style.display  = 'block';
    progBar.style.width    = '5%';

    try {
        const BATCH = 200;
        let done = 0;
        const total = _foToAdd.length + _foToUpdate.length + _foToDeactivate.length;

        // ── INSERT truly new records (futures only — no id yet) ────
        // Plain insert so Postgres auto-assigns the id.
        for (let i = 0; i < _foToAdd.length; i += BATCH) {
            const chunk = _foToAdd.slice(i, i + BATCH);
            const { error } = await window.supabaseClient
                .from('securities_nfo')
                .insert(chunk);
            if (error) throw error;
            done += chunk.length;
            progBar.style.width = Math.round(10 + (done / total) * 80) + '%';
            progLbl.textContent = 'Added ' + done.toLocaleString('en-IN') + ' of ' + total.toLocaleString('en-IN') + '...';
        }

        // ── UPDATE existing records by id ──────────────────────────
        // Uses plain UPDATE (not UPSERT) to comply with rule A.2.3: upsert
        // sends all columns and null-fills any key not in the object, which
        // would wipe strike_price / option_type / trading_session (we
        // deliberately omit these from the CSV row so they remain frozen at
        // the record-create value). UPDATE only touches the keys present.
        for (const item of _foToUpdate) {
            // Strip the id out of the payload — it's used as the WHERE key.
            const rec = Object.assign({}, item.record);
            const recId = rec.id;
            delete rec.id;
            const { error } = await window.supabaseClient
                .from('securities_nfo')
                .update(rec)
                .eq('id', recId);
            if (error) throw error;
            done++;
            if (done % 25 === 0 || done === total) {
                progBar.style.width = Math.round(10 + (done / total) * 80) + '%';
                progLbl.textContent = 'Updated ' + done.toLocaleString('en-IN') + ' of ' + total.toLocaleString('en-IN') + '...';
            }
        }

        // ── Mark expired contracts inactive ────────────────────────
        for (let i = 0; i < _foToDeactivate.length; i += BATCH) {
            const chunk = _foToDeactivate.slice(i, i + BATCH);
            const ids = chunk.map(r => r.id);
            const { error } = await window.supabaseClient
                .from('securities_nfo')
                .update({ is_active: false })
                .in('id', ids);
            if (error) throw error;
            done += chunk.length;
            progBar.style.width = Math.round(10 + (done / total) * 80) + '%';
            progLbl.textContent = 'Deactivating expired: ' + done.toLocaleString('en-IN') + ' of ' + total.toLocaleString('en-IN') + '...';
        }

        progBar.style.width = '100%';
        progLbl.textContent = 'Done.';
        localStorage.setItem('wms_last_fo_sync', new Date().toISOString());

        await loadFOStats();

        // Refresh shared FO cache and re-render
        await wmsLoadSecuritiesNfo();
        renderUnified();

        // Close modal
        closeSyncModal();

    } catch(e) {
        console.error('FO commit error', e);
        progLbl.textContent = 'Error: ' + e.message;
        progLbl.style.color = '#dc2626';
        btn.disabled = false;
        btn.textContent = '✓ Commit to Database';
    } finally {
        setFOLoading(false);
    }
}

function cancelFOSync() {
    closeSyncModal();
    document.getElementById('btnFOSync').disabled = false;
}

// ── Export FO to CSV ───────────────────────────────────────────
async function exportFOExcel() {
    setFOLoading(true, 'Preparing F&O export...');
    try {
        const rows = await fetchAllRows('securities_nfo',
            'symbol,instrument_name,exchange,instrument_type,underlying_symbol,' +
            'expiry_date,strike_price,option_type,lot_size,is_active,broker_tokens,updated_at');

        const headers = ['symbol','instrument_name','exchange','instrument_type',
            'underlying_symbol','expiry_date','strike_price','option_type',
            'lot_size','is_active','fyers_token','updated_at'];

        const csvRows = [headers.join(',')];
        for (const r of rows) {
            const tok = r.broker_tokens?.fyers?.token || '';
            csvRows.push([
                csv(r.symbol),          csv(r.instrument_name), csv(r.exchange),
                csv(r.instrument_type), csv(r.underlying_symbol), csv(r.expiry_date),
                r.strike_price ?? '',   csv(r.option_type),     r.lot_size ?? '',
                r.is_active ? 'TRUE' : 'FALSE', csv(tok),       csv(r.updated_at)
            ].join(','));
        }

        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = 'securities_nfo_' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch(e) {
        console.error('FO export failed', e);
        alert('Export failed: ' + e.message);
    } finally {
        setFOLoading(false);
    }
}

// ═══════════════════════════════════════════════════════════════
// PREFERENCES
// ═══════════════════════════════════════════════════════════════

function loadPreferences() {
    const user = window.currentUser;
    if (!user || !user.preferences) return;

    const prefs = user.preferences;
    if (document.getElementById('numberFormat'))    document.getElementById('numberFormat').value = prefs.number_format || 'indian';
    if (document.getElementById('amountDisplay'))   document.getElementById('amountDisplay').value = prefs.amount_display || 'thousands';
    if (document.getElementById('dateFormat'))      document.getElementById('dateFormat').value = prefs.date_format || 'dd-mmm-yy';
    if (document.getElementById('decimalPlaces'))   document.getElementById('decimalPlaces').value = prefs.decimal_places || 2;
}

async function savePreferences() {
    const user = window.currentUser;
    if (!user) {
        alert('User not loaded');
        return;
    }

    const prefs = {
        number_format: document.getElementById('numberFormat').value,
        amount_display: document.getElementById('amountDisplay').value,
        date_format: document.getElementById('dateFormat').value,
        decimal_places: parseInt(document.getElementById('decimalPlaces').value) || 2,
        currency_symbol: user.preferences?.currency_symbol || '₹',
        theme: user.preferences?.theme || 'light',
        default_view: user.preferences?.default_view || 'portfolio',
        financial_year_start: user.preferences?.financial_year_start || 4
    };

    try {
        const { error } = await window.supabaseClient
            .from('users')
            .update({ preferences: prefs })
            .eq('id', user.id);

        if (error) throw error;

        // Update in-memory user object and localStorage
        user.preferences = prefs;
        window.currentUser = user;
        localStorage.setItem('wms_user', JSON.stringify(user));

        alert('✅ Preferences saved successfully');
    } catch (e) {
        console.error('Save preferences error:', e);
        alert('Failed to save preferences: ' + e.message);
    }
}

// Expose modal functions globally for onclick handlers
window.openAddInvestorModal = openAddInvestorModal;
window.openAddBrokerModal = openAddBrokerModal;
window.closeInvestorModal = () => document.getElementById('investorModal').classList.remove('show');
window.closeBrokerModal = () => document.getElementById('brokerModal').classList.remove('show');
window.saveInvestor = saveInvestor;
window.saveBroker = saveBroker;
window.removeBrokerAccount = removeBrokerAccount;
window.loadBrokerDefaults = loadBrokerDefaults;
window.addBrokerAccount = addBrokerAccount;
window.startInlineEdit = startInlineEdit;
window.seedDefaultCharges = seedDefaultCharges;
window.switchChargesSubtab = switchChargesSubtab;

// ===================== REGULATORY CHARGES =====================

// Segment definitions matching Zerodha tabs
var CHARGE_SEGMENTS = {
    equity: {
        label: 'Equity',
        categories: ['EQUITY_DELIVERY', 'EQUITY_INTRADAY', 'EQUITY_FUTURES', 'EQUITY_OPTIONS'],
        catLabels: { EQUITY_DELIVERY:'Equity Delivery', EQUITY_INTRADAY:'Equity Intraday', EQUITY_FUTURES:'F&O - Futures', EQUITY_OPTIONS:'F&O - Options' },
        sttLabel: 'STT/CTT'
    },
    currency: {
        label: 'Currency',
        categories: ['CURRENCY_FUTURES', 'CURRENCY_OPTIONS'],
        catLabels: { CURRENCY_FUTURES:'Currency Futures', CURRENCY_OPTIONS:'Currency Options' },
        sttLabel: 'STT/CTT'
    },
    commodity: {
        label: 'Commodity',
        categories: ['COMMODITY_FUTURES', 'COMMODITY_OPTIONS'],
        catLabels: { COMMODITY_FUTURES:'Commodity Futures', COMMODITY_OPTIONS:'Commodity Options' },
        sttLabel: 'CTT'
    }
};
var CHARGE_TYPES = ['STT', 'EXCHANGE_CHARGES', 'SEBI_CHARGES', 'STAMP_DUTY', 'IPFT'];
var CHARGE_LABELS = {
    'STT': 'STT/CTT',
    'EXCHANGE_CHARGES': 'Transaction Charges',
    'SEBI_CHARGES': 'SEBI Charges',
    'STAMP_DUTY': 'Stamp Charges',
    'IPFT': 'NSE IPFT'
};
var _activeChargesSubtab = 'equity';

async function loadChargesConfig() {
    try {
        _chargesData = await DB.getChargesConfig();
        renderChargesGrid();
    } catch (e) {
        console.error('Failed to load charges:', e);
        document.getElementById('chargesGrid').innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Failed to load charges</h3></div>';
    }
}

function switchChargesSubtab(event, tab) {
    _activeChargesSubtab = tab;
    document.querySelectorAll('.charges-subtab').forEach(function(b) { b.classList.remove('active'); });
    event.target.classList.add('active');
    renderChargesGrid();
}

function getChargeRow(category, chargeType, side, exchange) {
    return _chargesData.find(r =>
        r.transaction_category === category &&
        r.charge_type === chargeType &&
        r.transaction_type === side &&
        r.exchange === exchange
    );
}

function getChargeRows(category, chargeType, side) {
    return _chargesData.filter(r =>
        r.transaction_category === category &&
        r.charge_type === chargeType &&
        (side ? r.transaction_type === side : true)
    );
}

function formatRate(val) {
    if (val === null || val === undefined) return '-';
    var n = parseFloat(val);
    return n.toFixed(6).replace(/\.?0+$/, '') + '%';
}

function renderChargesGrid() {
    var grid = document.getElementById('chargesGrid');
    var seedBtn = document.getElementById('seedChargesBtn');
    var effLabel = document.getElementById('chargesEffective');

    if (!_chargesData || _chargesData.length === 0) {
        grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💰</div><h3>No regulatory charges configured</h3><p>Click "Add Default Charges" to populate with current Indian market rates.</p></div>';
        seedBtn.style.display = 'inline-block';
        effLabel.textContent = '';
        return;
    }
    seedBtn.style.display = 'none';

    var dates = _chargesData.map(r => r.effective_from).filter(Boolean).sort();
    var latestDate = dates.length ? dates[dates.length - 1] : null;
    effLabel.textContent = latestDate ? 'Effective from: ' + formatDateShort(latestDate) : '';

    var seg = CHARGE_SEGMENTS[_activeChargesSubtab];
    var cats = seg.categories;
    var catLabels = seg.catLabels;

    var html = '<table class="data-table" style="font-size:13px;"><thead><tr>';
    html += '<th style="text-align:left;min-width:170px;"></th>';
    cats.forEach(function(cat) {
        html += '<th style="text-align:center;">' + catLabels[cat] + '</th>';
    });
    html += '</tr></thead><tbody>';

    // STT/CTT row
    html += '<tr><td style="font-weight:600;">' + seg.sttLabel + '</td>';
    cats.forEach(function(cat) {
        html += renderChargeCell(cat, 'STT');
    });
    html += '</tr>';

    // Transaction Charges row (shows multiple exchanges per cell)
    html += '<tr><td style="font-weight:600;">Transaction Charges</td>';
    cats.forEach(function(cat) {
        html += renderExchangeChargeCell(cat);
    });
    html += '</tr>';

    // GST row (read-only)
    html += '<tr><td style="font-weight:600;">GST</td>';
    cats.forEach(function(cat) {
        html += '<td style="text-align:center;color:#666;">18% on brokerage + SEBI charges + transaction charges</td>';
    });
    html += '</tr>';

    // SEBI Charges row
    html += '<tr><td style="font-weight:600;">SEBI Charges</td>';
    cats.forEach(function(cat) {
        html += renderChargeCell(cat, 'SEBI_CHARGES');
    });
    html += '</tr>';

    // Stamp Charges row
    html += '<tr><td style="font-weight:600;">Stamp Charges</td>';
    cats.forEach(function(cat) {
        html += renderChargeCell(cat, 'STAMP_DUTY');
    });
    html += '</tr>';

    // NSE IPFT row
    html += '<tr><td style="font-weight:600;">NSE IPFT</td>';
    cats.forEach(function(cat) {
        html += renderChargeCell(cat, 'IPFT');
    });
    html += '</tr>';

    html += '</tbody></table>';
    grid.innerHTML = html;
}

// Render a cell for STT, SEBI, STAMP — aggregates BUY+SELL into descriptive text
function renderChargeCell(cat, chargeType) {
    var rows = getChargeRows(cat, chargeType);
    if (rows.length === 0) return '<td style="text-align:center;color:#aaa;">-</td>';

    // Group by exchange — for non-exchange-charges, there may be just one exchange
    var buyRows = rows.filter(r => r.transaction_type === 'BUY');
    var sellRows = rows.filter(r => r.transaction_type === 'SELL');

    // Use first exchange found (STT/SEBI/STAMP are same across exchanges)
    var buyRow = buyRows[0];
    var sellRow = sellRows[0];
    var buyRate = buyRow ? parseFloat(buyRow.rate_percentage) : 0;
    var sellRate = sellRow ? parseFloat(sellRow.rate_percentage) : 0;
    var exch = (buyRow || sellRow).exchange;

    var parts = [];
    if (buyRate > 0 && sellRate > 0 && buyRate === sellRate) {
        parts.push('<span class="charge-cell" ondblclick="startInlineEdit(this)" data-id="' + buyRow.id + '" data-exch="' + exch + '" data-cat="' + cat + '" data-ct="' + chargeType + '" data-side="BUY" data-rate="' + buyRate + '" title="Double-click to edit">' + formatRate(buyRate) + '</span>');
        parts.push('<span style="color:#888;font-size:11px;"> on buy &amp; sell</span>');
    } else {
        if (buyRate > 0) {
            parts.push('<span class="charge-cell" ondblclick="startInlineEdit(this)" data-id="' + buyRow.id + '" data-exch="' + exch + '" data-cat="' + cat + '" data-ct="' + chargeType + '" data-side="BUY" data-rate="' + buyRate + '" title="Double-click to edit">' + formatRate(buyRate) + '</span>');
            parts.push('<span style="color:#888;font-size:11px;"> on buy</span>');
        }
        if (sellRate > 0) {
            if (buyRate > 0) parts.push('<br>');
            parts.push('<span class="charge-cell" ondblclick="startInlineEdit(this)" data-id="' + sellRow.id + '" data-exch="' + exch + '" data-cat="' + cat + '" data-ct="' + chargeType + '" data-side="SELL" data-rate="' + sellRate + '" title="Double-click to edit">' + formatRate(sellRate) + '</span>');
            parts.push('<span style="color:#888;font-size:11px;"> on sell</span>');
        }
        if (buyRate === 0 && sellRate === 0) {
            parts.push('<span style="color:#aaa;">Nil</span>');
        }
    }

    return '<td style="text-align:center;line-height:1.8;">' + parts.join('') + '</td>';
}

// Render transaction charges cell — shows each exchange on its own line
function renderExchangeChargeCell(cat) {
    var rows = getChargeRows(cat, 'EXCHANGE_CHARGES');
    if (rows.length === 0) return '<td style="text-align:center;color:#aaa;">-</td>';

    // Group by exchange
    var exchMap = {};
    rows.forEach(function(r) {
        if (!exchMap[r.exchange]) exchMap[r.exchange] = {};
        exchMap[r.exchange][r.transaction_type] = r;
    });

    var lines = [];
    Object.keys(exchMap).sort().forEach(function(exch) {
        var buyRow = exchMap[exch].BUY;
        var sellRow = exchMap[exch].SELL;
        // Use buy rate as representative (exchange charges are usually same both sides)
        var row = buyRow || sellRow;
        var rate = row ? parseFloat(row.rate_percentage) : 0;
        if (rate > 0) {
            lines.push('<span class="charge-cell" ondblclick="startInlineEdit(this)" data-id="' + row.id + '" data-exch="' + exch + '" data-cat="' + cat + '" data-ct="EXCHANGE_CHARGES" data-side="' + row.transaction_type + '" data-rate="' + rate + '" title="Double-click to edit" style="display:inline-block;">' + exch + ': ' + formatRate(rate) + '</span>');
        }
    });

    if (lines.length === 0) return '<td style="text-align:center;color:#aaa;">Nil</td>';
    return '<td style="text-align:center;line-height:1.8;">' + lines.join('<br>') + '</td>';
}

function formatDateShort(dateStr) { return formatDate(dateStr); }

function startInlineEdit(td) {
    // Don't open another input if already editing
    if (td.querySelector('input')) return;

    var origRate = parseFloat(td.dataset.rate) || 0;
    var input = document.createElement('input');
    input.type = 'number';
    input.step = '0.000001';
    input.min = '0';
    input.value = origRate;
    input.style.cssText = 'width:90px;text-align:center;font-size:13px;padding:2px 4px;border:2px solid #4A90D9;border-radius:3px;outline:none;';

    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveInlineEdit(td, input, origRate);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelInlineEdit(td, origRate);
        }
    });

    input.addEventListener('blur', function() {
        // Small delay to allow Enter to fire first
        setTimeout(function() {
            if (td.querySelector('input')) {
                cancelInlineEdit(td, origRate);
            }
        }, 150);
    });
}

function cancelInlineEdit(td, origRate) {
    var display = origRate > 0 ? formatRate(origRate) : '<span style="color:#aaa;">0%</span>';
    td.innerHTML = display;
}

async function saveInlineEdit(td, input, origRate) {
    var newRate = parseFloat(input.value) || 0;

    // No change — just cancel
    if (newRate === origRate) {
        cancelInlineEdit(td, origRate);
        return;
    }

    var rowId = td.dataset.id;
    var exch = td.dataset.exch;
    var cat = td.dataset.cat;
    var ct = td.dataset.ct;
    var side = td.dataset.side;
    var today = new Date().toISOString().split('T')[0];

    // Find the original row to preserve gst fields
    var origRow = _chargesData.find(function(r) { return r.id === rowId; });
    var gstApp = origRow ? origRow.gst_applicable : false;
    var gstRate = origRow ? origRow.gst_rate : null;

    // Show saving state
    td.innerHTML = '<span style="color:#888;">saving...</span>';

    try {
        // Expire old row
        if (rowId) {
            await DB.expireChargeRow(rowId, today);
        }
        // Insert new row
        await DB.insertChargeRows([{
            charge_type: ct,
            transaction_category: cat,
            transaction_type: side,
            exchange: exch,
            rate_percentage: newRate,
            gst_applicable: gstApp,
            gst_rate: gstRate,
            effective_from: today,
            effective_to: null
        }]);

        // Reload data and re-render
        _chargesData = await DB.getChargesConfig();
        renderChargesGrid();
        wmsLoadRefData(); // Refresh shared ref data after reg charges change
    } catch (e) {
        console.error('Failed to save charge:', e);
        alert('Error saving: ' + e.message);
        cancelInlineEdit(td, origRate);
    }
}

async function seedDefaultCharges() {
    var effDate = '2024-10-01'; // Oct 2024 Zerodha rates

    // Helper to build one charge row
    function r(ct, cat, side, rate, exch, gstApp, gstRate) {
        return { charge_type:ct, transaction_category:cat, transaction_type:side,
                 rate_percentage:rate, exchange:exch,
                 gst_applicable:!!gstApp, gst_rate:gstRate||null,
                 effective_from:effDate, effective_to:null };
    }

    // For govt charges (STT, STAMP, SEBI) we store one row per category+side (exchange = primary for that segment).
    // For EXCHANGE_CHARGES we store per-exchange rows.

    var defaults = [
        // ===================== EQUITY SEGMENT =====================
        // --- STT (same across exchanges, store under NSE) ---
        r('STT','EQUITY_DELIVERY','BUY',  0.1,  'NSE'), r('STT','EQUITY_DELIVERY','SELL', 0.1,  'NSE'),
        r('STT','EQUITY_INTRADAY','BUY',  0,    'NSE'), r('STT','EQUITY_INTRADAY','SELL', 0.025,'NSE'),
        r('STT','EQUITY_FUTURES', 'BUY',  0,    'NSE'), r('STT','EQUITY_FUTURES', 'SELL', 0.02, 'NSE'),
        r('STT','EQUITY_OPTIONS', 'BUY',  0,    'NSE'), r('STT','EQUITY_OPTIONS', 'SELL', 0.1,  'NSE'),

        // --- Exchange/Transaction Charges (per exchange) ---
        // NSE equity
        r('EXCHANGE_CHARGES','EQUITY_DELIVERY','BUY', 0.00297,'NSE',true,18), r('EXCHANGE_CHARGES','EQUITY_DELIVERY','SELL',0.00297,'NSE',true,18),
        r('EXCHANGE_CHARGES','EQUITY_INTRADAY','BUY', 0.00297,'NSE',true,18), r('EXCHANGE_CHARGES','EQUITY_INTRADAY','SELL',0.00297,'NSE',true,18),
        r('EXCHANGE_CHARGES','EQUITY_FUTURES', 'BUY', 0.00173,'NSE',true,18), r('EXCHANGE_CHARGES','EQUITY_FUTURES', 'SELL',0.00173,'NSE',true,18),
        r('EXCHANGE_CHARGES','EQUITY_OPTIONS', 'BUY', 0.03503,'NSE',true,18), r('EXCHANGE_CHARGES','EQUITY_OPTIONS', 'SELL',0.03503,'NSE',true,18),
        // BSE equity
        r('EXCHANGE_CHARGES','EQUITY_DELIVERY','BUY', 0.00375,'BSE',true,18), r('EXCHANGE_CHARGES','EQUITY_DELIVERY','SELL',0.00375,'BSE',true,18),
        r('EXCHANGE_CHARGES','EQUITY_INTRADAY','BUY', 0.00375,'BSE',true,18), r('EXCHANGE_CHARGES','EQUITY_INTRADAY','SELL',0.00375,'BSE',true,18),
        r('EXCHANGE_CHARGES','EQUITY_FUTURES', 'BUY', 0.00173,'BSE',true,18), r('EXCHANGE_CHARGES','EQUITY_FUTURES', 'SELL',0.00173,'BSE',true,18),
        r('EXCHANGE_CHARGES','EQUITY_OPTIONS', 'BUY', 0.0325, 'BSE',true,18), r('EXCHANGE_CHARGES','EQUITY_OPTIONS', 'SELL',0.0325, 'BSE',true,18),

        // --- SEBI Charges (₹10 per crore = 0.0001%, same all) ---
        r('SEBI_CHARGES','EQUITY_DELIVERY','BUY', 0.0001,'NSE',true,18), r('SEBI_CHARGES','EQUITY_DELIVERY','SELL',0.0001,'NSE',true,18),
        r('SEBI_CHARGES','EQUITY_INTRADAY','BUY', 0.0001,'NSE',true,18), r('SEBI_CHARGES','EQUITY_INTRADAY','SELL',0.0001,'NSE',true,18),
        r('SEBI_CHARGES','EQUITY_FUTURES', 'BUY', 0.0001,'NSE',true,18), r('SEBI_CHARGES','EQUITY_FUTURES', 'SELL',0.0001,'NSE',true,18),
        r('SEBI_CHARGES','EQUITY_OPTIONS', 'BUY', 0.0001,'NSE',true,18), r('SEBI_CHARGES','EQUITY_OPTIONS', 'SELL',0.0001,'NSE',true,18),

        // --- Stamp Duty (buy-side only, government-set) ---
        r('STAMP_DUTY','EQUITY_DELIVERY','BUY', 0.015,'NSE'), r('STAMP_DUTY','EQUITY_DELIVERY','SELL',0,'NSE'),
        r('STAMP_DUTY','EQUITY_INTRADAY','BUY', 0.003,'NSE'), r('STAMP_DUTY','EQUITY_INTRADAY','SELL',0,'NSE'),
        r('STAMP_DUTY','EQUITY_FUTURES', 'BUY', 0.002,'NSE'), r('STAMP_DUTY','EQUITY_FUTURES', 'SELL',0,'NSE'),
        r('STAMP_DUTY','EQUITY_OPTIONS', 'BUY', 0.003,'NSE'), r('STAMP_DUTY','EQUITY_OPTIONS', 'SELL',0,'NSE'),

        // ===================== CURRENCY SEGMENT =====================
        // --- STT/CTT (nil for currency) ---
        r('STT','CURRENCY_FUTURES','BUY', 0,'NSE'), r('STT','CURRENCY_FUTURES','SELL',0,'NSE'),
        r('STT','CURRENCY_OPTIONS','BUY', 0,'NSE'), r('STT','CURRENCY_OPTIONS','SELL',0,'NSE'),

        // --- Exchange/Transaction Charges ---
        // NSE currency
        r('EXCHANGE_CHARGES','CURRENCY_FUTURES','BUY', 0.00035,'NSE',true,18), r('EXCHANGE_CHARGES','CURRENCY_FUTURES','SELL',0.00035,'NSE',true,18),
        r('EXCHANGE_CHARGES','CURRENCY_OPTIONS','BUY', 0.0311, 'NSE',true,18), r('EXCHANGE_CHARGES','CURRENCY_OPTIONS','SELL',0.0311, 'NSE',true,18),
        // BSE currency
        r('EXCHANGE_CHARGES','CURRENCY_FUTURES','BUY', 0.00045,'BSE',true,18), r('EXCHANGE_CHARGES','CURRENCY_FUTURES','SELL',0.00045,'BSE',true,18),
        r('EXCHANGE_CHARGES','CURRENCY_OPTIONS','BUY', 0.001,  'BSE',true,18), r('EXCHANGE_CHARGES','CURRENCY_OPTIONS','SELL',0.001,  'BSE',true,18),

        // --- SEBI Charges ---
        r('SEBI_CHARGES','CURRENCY_FUTURES','BUY', 0.0001,'NSE',true,18), r('SEBI_CHARGES','CURRENCY_FUTURES','SELL',0.0001,'NSE',true,18),
        r('SEBI_CHARGES','CURRENCY_OPTIONS','BUY', 0.0001,'NSE',true,18), r('SEBI_CHARGES','CURRENCY_OPTIONS','SELL',0.0001,'NSE',true,18),

        // --- Stamp Duty ---
        r('STAMP_DUTY','CURRENCY_FUTURES','BUY', 0.0001,'NSE'), r('STAMP_DUTY','CURRENCY_FUTURES','SELL',0,'NSE'),
        r('STAMP_DUTY','CURRENCY_OPTIONS','BUY', 0.0001,'NSE'), r('STAMP_DUTY','CURRENCY_OPTIONS','SELL',0,'NSE'),

        // ===================== COMMODITY SEGMENT =====================
        // --- CTT (0.1% sell on options, nil on futures) ---
        r('STT','COMMODITY_FUTURES','BUY', 0,  'MCX'), r('STT','COMMODITY_FUTURES','SELL',0,  'MCX'),
        r('STT','COMMODITY_OPTIONS','BUY', 0,  'MCX'), r('STT','COMMODITY_OPTIONS','SELL',0.1,'MCX'),

        // --- Exchange/Transaction Charges (MCX only) ---
        r('EXCHANGE_CHARGES','COMMODITY_FUTURES','BUY', 0.0026,'MCX',true,18), r('EXCHANGE_CHARGES','COMMODITY_FUTURES','SELL',0.0026,'MCX',true,18),
        r('EXCHANGE_CHARGES','COMMODITY_OPTIONS','BUY', 0.05,  'MCX',true,18), r('EXCHANGE_CHARGES','COMMODITY_OPTIONS','SELL',0.05,  'MCX',true,18),

        // --- SEBI Charges ---
        r('SEBI_CHARGES','COMMODITY_FUTURES','BUY', 0.0001,'MCX',true,18), r('SEBI_CHARGES','COMMODITY_FUTURES','SELL',0.0001,'MCX',true,18),
        r('SEBI_CHARGES','COMMODITY_OPTIONS','BUY', 0.0001,'MCX',true,18), r('SEBI_CHARGES','COMMODITY_OPTIONS','SELL',0.0001,'MCX',true,18),

        // --- Stamp Duty ---
        r('STAMP_DUTY','COMMODITY_FUTURES','BUY', 0.002,'MCX'), r('STAMP_DUTY','COMMODITY_FUTURES','SELL',0,'MCX'),
        r('STAMP_DUTY','COMMODITY_OPTIONS','BUY', 0.003,'MCX'), r('STAMP_DUTY','COMMODITY_OPTIONS','SELL',0,'MCX')
    ];

    if (!confirm('This will insert ' + defaults.length + ' default charge rows (Oct 2024 Zerodha rates) for Equity, Currency & Commodity segments. Continue?')) return;

    try {
        await DB.insertChargeRows(defaults);
        _chargesData = await DB.getChargesConfig();
        renderChargesGrid();
        alert('Default charges added successfully! (' + defaults.length + ' rows)');
    } catch (e) {
        console.error('Failed to seed charges:', e);
        alert('Error: ' + e.message);
    }
}

// ============================================================================
// PRIVATE EQUITY (PE) SECURITIES
// ============================================================================

var editingPeSecurityId = null;

function _peModalEscHandler(e) {
    if (e.key === 'Escape') closePeSecurityModal();
}

// --- Dynamic dropdowns for PE modal ---

function _populatePeTypeDropdown(selectedValue) {
    var sel = document.getElementById('peType');
    var newInput = document.getElementById('peTypeNew');
    newInput.style.display = 'none';
    newInput.value = '';
    var vals = {};
    (wmsRefData.securitiesCm || []).forEach(function(s) {
        if (s.security_type) vals[s.security_type] = true;
    });
    // Ensure PRIVATE_EQUITY is always an option
    vals['PRIVATE_EQUITY'] = true;
    var sorted = Object.keys(vals).sort();
    var html = '';
    var defaultVal = selectedValue || 'PRIVATE_EQUITY';
    sorted.forEach(function(v) {
        html += '<option value="' + wmsEsc(v) + '"' + (v === defaultVal ? ' selected' : '') + '>' + wmsEsc(v) + '</option>';
    });
    if (defaultVal && !vals[defaultVal]) {
        html = '<option value="' + wmsEsc(defaultVal) + '" selected>' + wmsEsc(defaultVal) + '</option>' + html;
    }
    html += '<option value="__new__">+ Add new...</option>';
    sel.innerHTML = html;
    sel.onchange = function() {
        if (sel.value === '__new__') {
            newInput.style.display = '';
            newInput.focus();
        } else {
            newInput.style.display = 'none';
            newInput.value = '';
        }
    };
}

function _populatePeAssetClassDropdown(selectedValue) {
    var sel = document.getElementById('peAssetClass');
    var newInput = document.getElementById('peAssetClassNew');
    newInput.style.display = 'none';
    newInput.value = '';
    // Gather unique asset_class values from securitiesCm
    var vals = {};
    (wmsRefData.securitiesCm || []).forEach(function(s) {
        if (s.asset_class) vals[s.asset_class] = true;
    });
    var sorted = Object.keys(vals).sort();
    var html = '';
    sorted.forEach(function(v) {
        html += '<option value="' + wmsEsc(v) + '"' + (v === selectedValue ? ' selected' : '') + '>' + wmsEsc(v) + '</option>';
    });
    // If selectedValue not in list and not empty, add it
    if (selectedValue && !vals[selectedValue]) {
        html = '<option value="' + wmsEsc(selectedValue) + '" selected>' + wmsEsc(selectedValue) + '</option>' + html;
    }
    html += '<option value="__new__">+ Add new...</option>';
    sel.innerHTML = html;
    // Toggle new-input on "Add new" selection
    sel.onchange = function() {
        if (sel.value === '__new__') {
            newInput.style.display = '';
            newInput.focus();
        } else {
            newInput.style.display = 'none';
            newInput.value = '';
        }
    };
}

function _populatePeSectorDropdown(selectedValue) {
    var sel = document.getElementById('peSector');
    var newInput = document.getElementById('peSectorNew');
    newInput.style.display = 'none';
    newInput.value = '';
    // Gather unique sector values from securitiesCm
    var vals = {};
    (wmsRefData.securitiesCm || []).forEach(function(s) {
        if (s.sector) vals[s.sector] = true;
    });
    var sorted = Object.keys(vals).sort();
    var html = '<option value="">(none)</option>';
    sorted.forEach(function(v) {
        html += '<option value="' + wmsEsc(v) + '"' + (v === selectedValue ? ' selected' : '') + '>' + wmsEsc(v) + '</option>';
    });
    // If selectedValue not in list and not empty, add it
    if (selectedValue && !vals[selectedValue]) {
        html += '<option value="' + wmsEsc(selectedValue) + '" selected>' + wmsEsc(selectedValue) + '</option>';
    }
    html += '<option value="__new__">+ Add new...</option>';
    sel.innerHTML = html;
    sel.onchange = function() {
        if (sel.value === '__new__') {
            newInput.style.display = '';
            newInput.focus();
        } else {
            newInput.style.display = 'none';
            newInput.value = '';
        }
    };
}

function openAddPeSecurityModal() {
    editingPeSecurityId = null;
    document.getElementById('peSecurityModalTitle').textContent = 'Add PE Security';
    document.getElementById('peSecurityForm').reset();
    document.getElementById('peSecurityId').value = '';
    document.getElementById('peLotSize').value = '1';
    document.getElementById('peStatus').value = 'true';
    document.getElementById('peIsin').value = '';
    document.getElementById('btnPeDelete').style.display = 'none';
    var btnMerge = document.getElementById('btnPeMerge');
    if (btnMerge) btnMerge.style.display = 'none';
    var btnReverseMerge = document.getElementById('btnPeReverseMerge');
    if (btnReverseMerge) btnReverseMerge.style.display = 'none';
    var mergedBanner = document.getElementById('peMergedBanner');
    if (mergedBanner) mergedBanner.style.display = 'none';
    _populatePeTypeDropdown('PRIVATE_EQUITY');
    _populatePeAssetClassDropdown('');
    _populatePeSectorDropdown('');
    document.getElementById('peSecurityModal').classList.add('show');
    document.addEventListener('keydown', _peModalEscHandler);
    // Auto-update ISIN preview as user types symbol
    var symInput = document.getElementById('peSymbol');
    symInput.oninput = function() {
        var sym = symInput.value.trim().toUpperCase();
        document.getElementById('peIsin').value = sym ? 'PE-' + sym : '';
    };
}

function openEditPeSecurityModal(secId) {
    // Find the security in wmsRefData cache
    var sec = wmsRefData.securitiesCmMap[secId];
    if (!sec) { alert('Security not found'); return; }

    editingPeSecurityId = secId;
    document.getElementById('peSecurityModalTitle').textContent = 'Edit Security';
    document.getElementById('peSecurityId').value = sec.id;
    document.getElementById('peSymbol').value = sec.symbol || '';
    document.getElementById('peCompanyName').value = sec.company_name || '';
    _populatePeTypeDropdown(sec.security_type || 'PRIVATE_EQUITY');
    _populatePeAssetClassDropdown(sec.asset_class || '');
    _populatePeSectorDropdown(sec.sector || '');
    document.getElementById('peLotSize').value = sec.lot_size || 1;
    document.getElementById('peStatus').value = sec.is_active !== false ? 'true' : 'false';
    document.getElementById('peIsin').value = sec.isin || '';
    document.getElementById('btnPeDelete').style.display = sec.merged_into_id ? 'none' : 'inline-block';
    // Show merge button only if NOT already merged; show reverse merge if merged
    var btnMerge = document.getElementById('btnPeMerge');
    if (btnMerge) btnMerge.style.display = sec.merged_into_id ? 'none' : 'inline-block';
    var btnReverseMerge = document.getElementById('btnPeReverseMerge');
    if (btnReverseMerge) btnReverseMerge.style.display = sec.merged_into_id ? 'inline-block' : 'none';
    // Show merged status banner if merged
    var mergedBanner = document.getElementById('peMergedBanner');
    if (mergedBanner) {
        if (sec.merged_into_id) {
            var target = wmsRefData.securitiesCmMap[sec.merged_into_id];
            var targetName = target ? (target.symbol + ' — ' + target.company_name) : sec.merged_into_id;
            mergedBanner.innerHTML = '⚠️ This security was merged into <strong>' + wmsEsc(targetName) + '</strong> on ' + new Date(sec.merged_at).toLocaleDateString('en-IN');
            mergedBanner.style.display = 'block';
        } else {
            mergedBanner.style.display = 'none';
        }
    }
    document.getElementById('peSecurityModal').classList.add('show');
    document.addEventListener('keydown', _peModalEscHandler);
    // Auto-update ISIN preview — use correct prefix (PE- or RE-)
    var symInput = document.getElementById('peSymbol');
    var isinPrefix = (sec.isin && sec.isin.startsWith('RE-')) ? 'RE-' : 'PE-';
    symInput.oninput = function() {
        var sym = symInput.value.trim().toUpperCase();
        document.getElementById('peIsin').value = sym ? isinPrefix + sym : '';
    };
}

async function savePeSecurity() {
    var symbol = document.getElementById('peSymbol').value.trim().toUpperCase();
    var companyName = document.getElementById('peCompanyName').value.trim();

    if (!symbol) { alert('Please enter a symbol'); return; }
    if (!companyName) { alert('Please enter a company name'); return; }

    // Preserve existing ISIN prefix (RE- for RIGHTS, PE- for private equity)
    var existingIsin = document.getElementById('peIsin').value.trim();
    var isinPrefix = existingIsin.startsWith('RE-') ? 'RE-' : 'PE-';
    var isin = isinPrefix + symbol;
    // Resolve type — if "Add new" was selected, use the text input
    var typeSel = document.getElementById('peType').value;
    var securityType = typeSel === '__new__'
        ? (document.getElementById('peTypeNew').value.trim().toUpperCase() || 'PRIVATE_EQUITY')
        : typeSel || 'PRIVATE_EQUITY';
    // Resolve asset class — if "Add new" was selected, use the text input
    var acSel = document.getElementById('peAssetClass').value;
    var assetClass = acSel === '__new__'
        ? document.getElementById('peAssetClassNew').value.trim() || null
        : acSel || null;
    // Resolve sector — same logic
    var secSel = document.getElementById('peSector').value;
    var sector = secSel === '__new__'
        ? document.getElementById('peSectorNew').value.trim() || null
        : secSel || null;
    var data = {
        symbol: symbol,
        company_name: companyName,
        isin: isin,
        security_type: securityType,
        asset_class: assetClass,
        sector: sector,
        lot_size: parseInt(document.getElementById('peLotSize').value) || 1,
        is_active: document.getElementById('peStatus').value === 'true'
    };

    try {
        var headers = wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'});

        if (editingPeSecurityId) {
            // Update existing PE security
            var resp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?id=eq.' + editingPeSecurityId, {
                method: 'PATCH',
                headers: headers,
                body: JSON.stringify(data)
            });
            if (!resp.ok) {
                var errBody = await resp.text();
                throw new Error('Update failed: ' + errBody);
            }
        } else {
            // Check if PE-SYMBOL ISIN already exists
            var checkResp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?isin=eq.' + encodeURIComponent(isin) + '&select=id', {
                headers: wmsHeaders()
            });
            var existing = await checkResp.json();
            if (existing && existing.length > 0) {
                alert('A PE security with symbol "' + symbol + '" already exists (ISIN: ' + isin + ').');
                return;
            }

            // Insert new PE security
            var resp = await fetch(SUPABASE_URL + '/rest/v1/securities_db', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(data)
            });
            if (!resp.ok) {
                var errBody = await resp.text();
                throw new Error('Insert failed: ' + errBody);
            }
        }

        closePeSecurityModal();
        showAlert('Security "' + symbol + '" saved.', 'success', 4000);
        // Refresh securities cache in background (no double-load)
        await wmsLoadSecuritiesCm(0, {all: true});
        loadSecuritiesStats();
        loadSecuritiesTable(false);
    } catch (e) {
        console.error('Error saving PE security:', e);
        wmsShowError('Save failed', e);
    }
}

async function deletePeSecurity() {
    if (!editingPeSecurityId) return;
    var sec = wmsRefData.securitiesCmMap[editingPeSecurityId];
    var symbol = document.getElementById('peSymbol').value.trim().toUpperCase();

    // Block delete if already merged
    if (sec && sec.merged_into_id) {
        alert('Cannot delete "' + symbol + '" — it has been merged into another security. Use "Reverse Merge" first if you need to remove it.');
        return;
    }

    try {
        // Block delete if any transactions reference this security
        var headers = wmsHeaders();
        var countResp = await fetch(SUPABASE_URL + '/rest/v1/transactions?security_id=eq.' + editingPeSecurityId + '&select=id', { headers: headers });
        var txnRows = await countResp.json();
        var txnCount = Array.isArray(txnRows) ? txnRows.length : 0;

        if (txnCount > 0) {
            alert('Cannot delete "' + symbol + '" — ' + txnCount + ' transaction(s) reference this security.\n\nDelete or reassign the transactions first, then try again.');
            return;
        }

        if (!confirm('Delete security "' + symbol + '"?\n\nThis cannot be undone.')) return;

        var resp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?id=eq.' + editingPeSecurityId, {
            method: 'DELETE',
            headers: headers
        });
        if (!resp.ok) {
            var errBody = await resp.text();
            throw new Error('Delete failed: ' + errBody);
        }
        closePeSecurityModal();
        showAlert('Security "' + symbol + '" deleted.', 'success', 4000);
        // Refresh securities cache in background (no double-load)
        await wmsLoadSecuritiesCm(0, {all: true});
        loadSecuritiesStats();
        loadSecuritiesTable(false);
    } catch (e) {
        console.error('Error deleting PE security:', e);
        wmsShowError('Delete failed', e);
    }
}

function closePeSecurityModal() {
    document.getElementById('peSecurityModal').classList.remove('show');
    document.removeEventListener('keydown', _peModalEscHandler);
    editingPeSecurityId = null;
}

// ============================================================================
// MERGE SECURITY MODAL — Merge PE security into a listed security
// ============================================================================

var _mergeSourceId = null;
var _mergeTargetId = null;
var _mergeSourceTxnCount = 0;
var _mergeDateCtrl = null;  // wmsDateInput controller for merge date

function _mergeModalEscHandler(e) {
    if (e.key === 'Escape') closeMergeSecurityModal();
}

async function openMergeSecurityModal() {
    if (!editingPeSecurityId) return;
    var sec = wmsRefData.securitiesCmMap[editingPeSecurityId];
    if (!sec) return;
    if (sec.merged_into_id) {
        alert('This security has already been merged.');
        return;
    }

    _mergeSourceId = editingPeSecurityId;
    _mergeTargetId = null;
    _mergeSourceTxnCount = 0;

    // Fetch transaction count for source
    try {
        var headers = wmsHeaders();
        var resp = await fetch(SUPABASE_URL + '/rest/v1/transactions?security_id=eq.' + _mergeSourceId + '&select=id', { headers: headers });
        var txns = await resp.json();
        _mergeSourceTxnCount = Array.isArray(txns) ? txns.length : 0;
    } catch (e) { console.error('Error fetching txn count for merge:', e); }

    // Populate source summary
    var srcHtml = '<div style="font-weight:600;margin-bottom:4px;">Source (user-defined security)</div>' +
        '<div><strong>' + wmsEsc(sec.symbol) + '</strong> — ' + wmsEsc(sec.company_name || '') + '</div>' +
        '<div style="color:#718096;margin-top:2px;">ISIN: ' + wmsEsc(sec.isin || '') + ' · Type: ' + wmsEsc(sec.security_type || '') + ' · Transactions: ' + _mergeSourceTxnCount + '</div>';
    document.getElementById('mergeSourceSummary').innerHTML = srcHtml;

    // Reset target state
    document.getElementById('mergeTargetSearch').value = '';
    document.getElementById('mergeSearchResults').style.display = 'none';
    document.getElementById('mergeSearchResults').innerHTML = '';
    document.getElementById('mergeSelectedTarget').style.display = 'none';
    document.getElementById('mergeDateRow').style.display = 'none';
    if (_mergeDateCtrl) { _mergeDateCtrl.destroy(); _mergeDateCtrl = null; }
    document.getElementById('mergeConfirmSummary').style.display = 'none';
    document.getElementById('btnMergeConfirm').style.display = 'none';

    // Close PE modal, open merge modal
    closePeSecurityModal();
    document.getElementById('mergeSecurityModal').classList.add('show');
    document.addEventListener('keydown', _mergeModalEscHandler);
    document.getElementById('mergeTargetSearch').focus();
}

function closeMergeSecurityModal() {
    document.getElementById('mergeSecurityModal').classList.remove('show');
    document.removeEventListener('keydown', _mergeModalEscHandler);
    _mergeSourceId = null;
    _mergeTargetId = null;
}

function _mergeSearchTarget(query) {
    var resultsDiv = document.getElementById('mergeSearchResults');
    if (!query || query.length < 2) {
        resultsDiv.style.display = 'none';
        return;
    }
    var results = wmsSearchSecurities(query);
    // Filter out the source security itself and NFO securities
    results = results.filter(function(s) { return s.id !== _mergeSourceId && s.company_name; });
    if (results.length === 0) {
        resultsDiv.innerHTML = '<div style="padding:8px 12px;color:#a0aec0;font-size:12px;">No matching securities found</div>';
        resultsDiv.style.display = 'block';
        return;
    }
    var html = '';
    results.slice(0, 15).forEach(function(s) {
        var sym = s.nse_symbol || s.bse_symbol || s.symbol;
        html += '<div style="padding:6px 12px;cursor:pointer;border-bottom:1px solid #f1f5f9;font-size:12px;" ' +
            'onmouseover="this.style.background=\'#f7fafc\'" onmouseout="this.style.background=\'white\'" ' +
            'onclick="_mergeSelectTarget(\'' + s.id + '\')">' +
            '<strong>' + wmsEsc(sym) + '</strong> — ' + wmsEsc(s.company_name || '') +
            '<span style="color:#a0aec0;margin-left:8px;">' + wmsEsc(s.isin || '') + '</span>' +
            '</div>';
    });
    resultsDiv.innerHTML = html;
    resultsDiv.style.display = 'block';
}

function _mergeSelectTarget(targetId) {
    var target = wmsRefData.securitiesCmMap[targetId];
    if (!target) return;
    _mergeTargetId = targetId;

    // Hide search results, show selected target
    document.getElementById('mergeSearchResults').style.display = 'none';
    var sym = target.nse_symbol || target.bse_symbol || target.symbol;
    document.getElementById('mergeSelectedTarget').innerHTML =
        '<div style="font-weight:600;margin-bottom:4px;">Target (listed security)</div>' +
        '<div><strong>' + wmsEsc(sym) + '</strong> — ' + wmsEsc(target.company_name || '') + '</div>' +
        '<div style="color:#065f46;margin-top:2px;">ISIN: ' + wmsEsc(target.isin || '') + ' · Type: ' + wmsEsc(target.security_type || '') + '</div>';
    document.getElementById('mergeSelectedTarget').style.display = 'block';

    // Show merge date input (default to today) — uses wmsDateInput per Rule D.5.4
    document.getElementById('mergeDateRow').style.display = 'block';
    if (!_mergeDateCtrl) {
        _mergeDateCtrl = wmsDateInput(document.getElementById('mergeDateContainer'), {});
        _mergeDateCtrl.setValue(new Date());
    }

    // Show confirm summary
    var source = wmsRefData.securitiesCmMap[_mergeSourceId];
    document.getElementById('mergeConfirmSummary').innerHTML =
        '⚠️ <strong>This will transfer ' + _mergeSourceTxnCount + ' transaction(s)</strong> from ' +
        wmsEsc(source ? source.symbol : '') + ' to ' + wmsEsc(sym) + '. ' +
        'A merge note will be appended to each transaction\'s notes field for audit traceability. ' +
        'You can reverse this merge later if needed.';
    document.getElementById('mergeConfirmSummary').style.display = 'block';
    document.getElementById('btnMergeConfirm').style.display = 'inline-block';
}

async function executeMergeSecurity() {
    if (!_mergeSourceId || !_mergeTargetId) return;
    var source = wmsRefData.securitiesCmMap[_mergeSourceId];
    var target = wmsRefData.securitiesCmMap[_mergeTargetId];
    if (!source || !target) { alert('Source or target security not found.'); return; }

    var btn = document.getElementById('btnMergeConfirm');
    btn.textContent = 'Merging...';
    btn.disabled = true;

    try {
        var headers = wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'});
        var headersRead = wmsHeaders();

        // 1. Fetch all transactions for source security
        var txnResp = await fetch(SUPABASE_URL + '/rest/v1/transactions?security_id=eq.' + _mergeSourceId + '&select=id,notes', { headers: headersRead });
        if (!txnResp.ok) throw new Error('Failed to fetch transactions: ' + await txnResp.text());
        var txns = await txnResp.json();

        // 2. Resolve target display fields
        var targetSymbol = target.nse_symbol || target.bse_symbol || target.symbol;
        var targetShortSymbol = target.nse_symbol || target.bse_symbol || target.symbol;
        var targetCompanyName = target.company_name;
        var targetExchange = target.nse_symbol ? 'NSE' : (target.bse_symbol ? 'BSE' : 'NSE');
        var targetSecurityType = target.security_type || 'EQUITY';
        // Merge date: user-entered or default to today
        var mergeDateStr = (_mergeDateCtrl ? _mergeDateCtrl.getValue() : null) || new Date().toISOString().slice(0, 10);
        var mergeDateDisplay = new Date(mergeDateStr + 'T00:00:00').toLocaleDateString('en-IN');
        // Merge note for traceability — appended to notes field (tags are never modified programmatically)
        var mergeNote = '[MERGED from ' + (source.isin || 'PE-' + source.symbol) + ' (' + (source.company_name || source.symbol) + ') on ' + mergeDateDisplay + ']';

        // 3. Update each transaction — change security fields + append merge note
        var successCount = 0;
        for (var i = 0; i < txns.length; i++) {
            var txn = txns[i];
            // Append merge note to existing notes
            var existingNotes = txn.notes || '';
            var updatedNotes = existingNotes ? existingNotes + ' ' + mergeNote : mergeNote;

            var patchData = {
                security_id: _mergeTargetId,
                symbol: targetSymbol,
                short_symbol: targetShortSymbol,
                company_name: targetCompanyName,
                exchange: targetExchange,
                security_type: targetSecurityType,
                notes: updatedNotes
            };

            var patchResp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txn.id, {
                method: 'PATCH',
                headers: headers,
                body: JSON.stringify(patchData)
            });
            if (!patchResp.ok) {
                var errText = await patchResp.text();
                throw new Error('Failed to update transaction ' + txn.id + ': ' + errText);
            }
            successCount++;
        }

        // 4. Mark source PE security as merged
        var mergeResp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?id=eq.' + _mergeSourceId, {
            method: 'PATCH',
            headers: headers,
            body: JSON.stringify({
                merged_into_id: _mergeTargetId,
                merged_at: mergeDateStr + 'T00:00:00.000Z',
                is_active: false
            })
        });
        if (!mergeResp.ok) throw new Error('Failed to mark source as merged: ' + await mergeResp.text());

        // 5. Refresh caches
        closeMergeSecurityModal();
        showAlert('Merge complete! ' + successCount + ' transaction(s) transferred from ' + source.symbol + ' to ' + targetSymbol + '.', 'success', 5000);
        await wmsLoadSecuritiesCm(0, {all: true});
        loadSecuritiesStats();
        loadSecuritiesTable(false);
        // Refresh trading data if trading module is loaded
        if (typeof trLoadData === 'function') {
            try { await trLoadData(); } catch (e) { /* ignore */ }
        }
    } catch (e) {
        console.error('Merge error:', e);
        wmsShowError('Merge failed', e);
        btn.textContent = 'Confirm Merge';
        btn.disabled = false;
    }
}

async function reverseMergeSecurity() {
    if (!editingPeSecurityId) return;
    var sec = wmsRefData.securitiesCmMap[editingPeSecurityId];
    if (!sec || !sec.merged_into_id) {
        alert('This security has not been merged.');
        return;
    }

    var target = wmsRefData.securitiesCmMap[sec.merged_into_id];
    var targetName = target ? (target.symbol + ' — ' + target.company_name) : sec.merged_into_id;

    if (!confirm('Reverse merge of "' + sec.symbol + '"?\n\nThis will:\n• Move transactions back from ' + targetName + ' to ' + sec.symbol + '\n• Restore this security as active\n• Remove merge notes from transactions\n\nProceed?')) return;

    try {
        var headers = wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'});
        var headersRead = wmsHeaders();

        // 1. Find transactions that were merged — search notes containing the merge marker
        // Use PostgREST `like` for substring match since user may have added their own notes
        var mergeMarker = '[MERGED from ' + (sec.isin || 'PE-' + sec.symbol);
        var txnResp = await fetch(SUPABASE_URL + '/rest/v1/transactions?security_id=eq.' + sec.merged_into_id + '&notes=like.*' + encodeURIComponent(mergeMarker) + '*&select=id,notes', { headers: headersRead });
        if (!txnResp.ok) throw new Error('Failed to find merged transactions: ' + await txnResp.text());
        var txns = await txnResp.json();

        if (txns.length === 0) {
            alert('No transactions found with the merge note. The merge may have already been reversed, or the notes were manually cleared.');
            return;
        }

        // 2. Build source security display fields for restoring transactions
        var sourceSymbol = sec.symbol;
        var sourceShortSymbol = sec.symbol;
        var sourceCompanyName = sec.company_name;
        var sourceExchange = sec.nse_symbol ? 'NSE' : (sec.bse_symbol ? 'BSE' : 'NSE');
        var sourceSecurityType = sec.security_type || 'PRIVATE_EQUITY';

        // 3. Update each transaction back to the source
        var successCount = 0;
        for (var i = 0; i < txns.length; i++) {
            var txn = txns[i];
            // Remove the merge note from notes — find and strip the [MERGED from ...] block
            var cleanedNotes = (txn.notes || '').replace(/\s*\[MERGED from PE-[^\]]*\]/g, '').trim() || null;

            var patchData = {
                security_id: editingPeSecurityId,
                symbol: sourceSymbol,
                short_symbol: sourceShortSymbol,
                company_name: sourceCompanyName,
                exchange: sourceExchange,
                security_type: sourceSecurityType,
                notes: cleanedNotes
            };

            var patchResp = await fetch(SUPABASE_URL + '/rest/v1/transactions?id=eq.' + txn.id, {
                method: 'PATCH',
                headers: headers,
                body: JSON.stringify(patchData)
            });
            if (!patchResp.ok) throw new Error('Failed to update transaction ' + txn.id + ': ' + await patchResp.text());
            successCount++;
        }

        // 4. Clear merge fields on source PE security, restore as active
        var clearResp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?id=eq.' + editingPeSecurityId, {
            method: 'PATCH',
            headers: headers,
            body: JSON.stringify({
                merged_into_id: null,
                merged_at: null,
                is_active: true
            })
        });
        if (!clearResp.ok) throw new Error('Failed to clear merge on source security: ' + await clearResp.text());

        // 5. Refresh caches
        closePeSecurityModal();
        showAlert('Merge reversed! ' + successCount + ' transaction(s) moved back to ' + sourceSymbol + '.', 'success', 5000);
        await wmsLoadSecuritiesCm(0, {all: true});
        loadSecuritiesStats();
        loadSecuritiesTable(false);
        if (typeof trLoadData === 'function') {
            try { await trLoadData(); } catch (e) { /* ignore */ }
        }
    } catch (e) {
        console.error('Reverse merge error:', e);
        wmsShowError('Reverse merge failed', e);
    }
}

// ============================================================================
// SECURITY DETAILS MODAL — Read-only view on double-click
// ============================================================================

function _secDetailsEscHandler(e) {
    if (e.key === 'Escape') closeSecDetailsModal();
}

function _secDetailBlock(title, rows) {
    var html = '<div style="margin-bottom:12px;">' +
        '<div style="font-size:11px;font-weight:700;color:#667eea;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;padding:0 2px;">' + wmsEsc(title) + '</div>' +
        '<div style="background:#f7fafc;border:1px solid #edf2f7;border-radius:6px;overflow:hidden;">';
    rows.forEach(function(r, i) {
        var val = r[1] != null && r[1] !== '' ? String(r[1]) : '—';
        var borderStyle = i < rows.length - 1 ? 'border-bottom:1px solid #edf2f7;' : '';
        html += '<div style="display:flex;padding:5px 10px;' + borderStyle + 'font-size:11px;">' +
            '<span style="width:120px;flex-shrink:0;font-weight:600;color:#4a5568;">' + wmsEsc(r[0]) + '</span>' +
            '<span style="color:#2d3748;word-break:break-all;">' + wmsEsc(val) + '</span></div>';
    });
    html += '</div></div>';
    return html;
}

function openSecDetailsModal(secId) {
    var sec = wmsRefData.securitiesCmMap[secId];
    if (!sec) return;

    document.getElementById('secDetailsTitle').textContent = (sec.symbol || '') + ' — Details';

    var html = '';

    // Block 1: Identity
    html += _secDetailBlock('Identity', [
        ['Symbol', sec.symbol],
        ['Company Name', sec.company_name],
        ['ISIN', sec.isin],
        ['ID', sec.id]
    ]);

    // Block 2: Classification
    html += _secDetailBlock('Classification', [
        ['Security Type', sec.security_type],
        ['Asset Class', sec.asset_class],
        ['Sector', sec.sector],
        ['Size', sec.size]
    ]);

    // Block 3: Exchange
    html += _secDetailBlock('Exchange', [
        ['NSE Symbol', sec.nse_symbol],
        ['BSE Symbol', sec.bse_symbol],
        ['Lot Size', sec.lot_size],
        ['Status', sec.is_active !== false ? 'Active' : 'Inactive']
    ]);

    // Block 4: Broker Tokens (if any)
    var bt = sec.broker_tokens;
    if (bt && typeof bt === 'object') {
        var brokerNames = Object.keys(bt);
        brokerNames.forEach(function(broker) {
            var bData = bt[broker];
            if (!bData || typeof bData !== 'object') return;
            var bRows = [];
            Object.keys(bData).sort().forEach(function(key) {
                bRows.push([key, bData[key]]);
            });
            if (bRows.length) {
                html += _secDetailBlock('Broker: ' + broker.charAt(0).toUpperCase() + broker.slice(1), bRows);
            }
        });
    }

    document.getElementById('secDetailsBody').innerHTML = html;
    document.getElementById('secDetailsModal').classList.add('show');
    document.addEventListener('keydown', _secDetailsEscHandler);
}

function closeSecDetailsModal() {
    document.getElementById('secDetailsModal').classList.remove('show');
    document.removeEventListener('keydown', _secDetailsEscHandler);
}

// ============================================================================
// INLINE EDIT — Double-click on Asset Class, Sector, Size cells in table
// Shows a single-select dropdown with existing values + text input for new.
// ============================================================================

var _secInlineDropdown = null; // currently open inline dropdown element
var _secInlineOutsideHandler = null;

function _secGetUniqueValues(field) {
    var vals = new Set();
    var cmData = wmsRefData.securitiesCm || [];
    for (var i = 0; i < cmData.length; i++) {
        var v = cmData[i][field];
        if (v) vals.add(v);
    }
    return Array.from(vals).sort();
}

function _secCloseInlineDropdown() {
    if (_secInlineDropdown) {
        _secInlineDropdown.remove();
        _secInlineDropdown = null;
    }
    if (_secInlineOutsideHandler) {
        document.removeEventListener('mousedown', _secInlineOutsideHandler);
        _secInlineOutsideHandler = null;
    }
}

function _secOpenInlineDropdown(cell) {
    _secCloseInlineDropdown();

    var field = cell.dataset.field;
    var secId = cell.dataset.secid;
    var currentVal = (cell.textContent || '').trim();
    if (currentVal === '—') currentVal = '';

    var allValues = _secGetUniqueValues(field);
    var fieldLabel = field === 'asset_class' ? 'Asset Class' : field === 'sector' ? 'Sector' : field === 'security_type' ? 'Type' : 'Size';

    // Create dropdown
    var dd = document.createElement('div');
    dd.className = 'sec-inline-dd';
    dd.style.cssText = 'position:absolute;z-index:1000;background:white;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,0.12);padding:8px;min-width:200px;max-width:280px;';

    // Search input
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = currentVal;
    inp.placeholder = 'Type to search or add new...';
    inp.style.cssText = 'width:100%;padding:5px 8px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px;margin-bottom:6px;box-sizing:border-box;outline:none;';
    dd.appendChild(inp);

    // Pills container
    var pillsWrap = document.createElement('div');
    pillsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;max-height:160px;overflow-y:auto;';
    dd.appendChild(pillsWrap);

    function renderPills(query) {
        var q = (query || '').toLowerCase().trim();
        var filtered = q ? allValues.filter(function(v) { return v.toLowerCase().indexOf(q) >= 0; }) : allValues;
        pillsWrap.innerHTML = filtered.map(function(v) {
            var isOn = v === currentVal ? ' style="background:#667eea;border-color:#667eea;color:white;"' : '';
            return '<span class="ms-pill" data-val="' + v.replace(/"/g, '&quot;') + '"' + isOn + '>' + v + '</span>';
        }).join('');
        // If query doesn't match any existing value, show "Add new" pill
        if (q && !allValues.some(function(v) { return v.toLowerCase() === q; })) {
            pillsWrap.insertAdjacentHTML('afterbegin',
                '<span class="ms-pill" data-val="__new__" style="background:#f0fff4;border-color:#48bb78;color:#22543d;font-style:italic;">+ "' + query.trim() + '"</span>');
        }
        // Clear option
        if (currentVal) {
            pillsWrap.insertAdjacentHTML('beforeend',
                '<span class="ms-pill" data-val="__clear__" style="background:#fff5f5;border-color:#fc8181;color:#822727;font-style:italic;">✕ Clear</span>');
        }
    }

    renderPills('');

    // Click on a pill
    pillsWrap.addEventListener('click', function(e) {
        var pill = e.target.closest('.ms-pill');
        if (!pill) return;
        var val = pill.dataset.val;
        if (val === '__new__') val = inp.value.trim();
        else if (val === '__clear__') val = null;
        _secSaveInlineEdit(secId, field, val, cell);
    });

    // Search filter on input
    inp.addEventListener('input', function() {
        renderPills(inp.value);
    });

    // Enter key = save typed value
    inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            var val = inp.value.trim() || null;
            _secSaveInlineEdit(secId, field, val, cell);
        }
        if (e.key === 'Escape') {
            _secCloseInlineDropdown();
        }
    });

    // Position relative to cell
    var rect = cell.getBoundingClientRect();
    dd.style.position = 'fixed';
    dd.style.left = rect.left + 'px';
    dd.style.top = (rect.bottom + 2) + 'px';
    document.body.appendChild(dd);
    _secInlineDropdown = dd;
    inp.focus();
    inp.select();

    // Close on click outside
    setTimeout(function() {
        _secInlineOutsideHandler = function(e) {
            if (!dd.contains(e.target) && e.target !== cell) {
                _secCloseInlineDropdown();
            }
        };
        document.addEventListener('mousedown', _secInlineOutsideHandler);
    }, 10);
}

async function _secSaveInlineEdit(secId, field, value, cell) {
    _secCloseInlineDropdown();
    var patch = {};
    patch[field] = value;

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/securities_db?id=eq.' + secId, {
            method: 'PATCH',
            headers: wmsHeaders({'Content-Type': 'application/json', 'Prefer': 'return=representation'}),
            body: JSON.stringify(patch)
        });
        if (!resp.ok) throw new Error(await resp.text());

        // Update local cache
        var sec = wmsRefData.securitiesCmMap[secId];
        if (sec) sec[field] = value;

        // Update cell display
        if (field === 'security_type') {
            cell.innerHTML = value ? _typeBadge(value) : '<span style="color:#cbd5e0;">—</span>';
        } else {
            cell.innerHTML = value ? value : '<span style="color:#cbd5e0;">—</span>';
        }

        // Refresh filter pills if the value is new
        if (field === 'asset_class') populateAssetClassPills();
        else if (field === 'sector') populateSectorPills();
        else if (field === 'size') populateSizePills();
        else if (field === 'security_type') populateTypePills();
    } catch (e) {
        console.error('Inline edit save error:', e);
        alert('Error saving: ' + e.message);
    }
}

// Attach dblclick handler via event delegation on tbody
(function() {
    function attachSecInlineEdit() {
        var tbody = document.getElementById('secTbody');
        if (!tbody || tbody._secInlineEditAttached) return;
        tbody.addEventListener('dblclick', function(e) {
            // 1) Inline edit on Asset Class / Sector cells
            var cell = e.target.closest('.sec-inline-edit');
            if (cell) {
                e.preventDefault();
                _secOpenInlineDropdown(cell);
                return;
            }
            // 2) Details modal on any other part of a CM row
            var row = e.target.closest('tr[data-secid]');
            if (row) {
                e.preventDefault();
                var secId = row.dataset.secid;
                if (secId) openSecDetailsModal(secId);
            }
        });
        tbody._secInlineEditAttached = true;
    }
    // Attach after DOM ready — try immediately, then retry on tab switch
    if (document.getElementById('secTbody')) attachSecInlineEdit();
    var origSwitch = window.switchTab;
    if (origSwitch) {
        window.switchTab = function(event, tabName) {
            origSwitch(event, tabName);
            if (tabName === 'securities') setTimeout(attachSecInlineEdit, 100);
        };
    }
    // Also try on DOMContentLoaded
    document.addEventListener('DOMContentLoaded', attachSecInlineEdit);
})();
