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
            headers: { 'apikey': this.supabaseKey, 'Authorization': `Bearer ${this.supabaseKey}` }
        });
        return await response.json();
    },
    
    async addInvestor(data) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/investors`, {
            method: 'POST',
            headers: { 
                'apikey': this.supabaseKey, 
                'Authorization': `Bearer ${this.supabaseKey}`, 
                'Content-Type': 'application/json', 
                'Prefer': 'return=representation' 
            },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        return result[0];
    },
    
    async updateInvestor(id, data) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/investors?id=eq.${id}`, {
            method: 'PATCH',
            headers: { 
                'apikey': this.supabaseKey, 
                'Authorization': `Bearer ${this.supabaseKey}`, 
                'Content-Type': 'application/json', 
                'Prefer': 'return=representation' 
            },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        return result[0];
    },
    
    async deleteInvestor(id) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/investors?id=eq.${id}`, {
            method: 'DELETE',
            headers: { 'apikey': this.supabaseKey, 'Authorization': `Bearer ${this.supabaseKey}` }
        });
        return response.ok;
    },
    
    async getBrokers() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/brokers?select=*&order=name.asc`, {
            headers: { 'apikey': this.supabaseKey, 'Authorization': `Bearer ${this.supabaseKey}` }
        });
        return await response.json();
    },
    
    async addBroker(data) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/brokers`, {
            method: 'POST',
            headers: { 
                'apikey': this.supabaseKey, 
                'Authorization': `Bearer ${this.supabaseKey}`, 
                'Content-Type': 'application/json', 
                'Prefer': 'return=representation' 
            },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        return result[0];
    },
    
    async updateBroker(id, data) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/brokers?id=eq.${id}`, {
            method: 'PATCH',
            headers: { 
                'apikey': this.supabaseKey, 
                'Authorization': `Bearer ${this.supabaseKey}`, 
                'Content-Type': 'application/json', 
                'Prefer': 'return=representation' 
            },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        return result[0];
    },
    
    async deleteBroker(id) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/brokers?id=eq.${id}`, {
            method: 'DELETE',
            headers: { 'apikey': this.supabaseKey, 'Authorization': `Bearer ${this.supabaseKey}` }
        });
        return response.ok;
    },
    
    async getBrokerAccounts(investorId) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/investor_broker_accounts?investor_id=eq.${investorId}&select=*`, {
            headers: { 'apikey': this.supabaseKey, 'Authorization': `Bearer ${this.supabaseKey}` }
        });
        return await response.json();
    },
    
    async getAllBrokerAccounts() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/investor_broker_accounts?select=*`, {
            headers: { 'apikey': this.supabaseKey, 'Authorization': `Bearer ${this.supabaseKey}` }
        });
        return await response.json();
    },
    
    async saveBrokerAccounts(investorId, accounts) {
        // Delete existing accounts
        await fetch(`${this.supabaseUrl}/rest/v1/investor_broker_accounts?investor_id=eq.${investorId}`, {
            method: 'DELETE',
            headers: { 'apikey': this.supabaseKey, 'Authorization': `Bearer ${this.supabaseKey}` }
        });
        
        // Insert new accounts
        if (accounts.length > 0) {
            const accountsData = accounts.map(acc => ({ investor_id: investorId, ...acc, is_active: true }));
            await fetch(`${this.supabaseUrl}/rest/v1/investor_broker_accounts`, {
                method: 'POST',
                headers: { 
                    'apikey': this.supabaseKey, 
                    'Authorization': `Bearer ${this.supabaseKey}`, 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify(accountsData)
            });
        }
        return Promise.resolve(true);
    },
    
    async getUser() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/users?select=*&limit=1`, {
            headers: { 'apikey': this.supabaseKey, 'Authorization': `Bearer ${this.supabaseKey}` }
        });
        const users = await response.json();
        return users[0] || null;
    },
    
    async updateUserPreferences(preferences) {
        const user = await this.getUser();
        if (user) {
            await fetch(`${this.supabaseUrl}/rest/v1/users?id=eq.${user.id}`, {
                method: 'PATCH',
                headers: {
                    'apikey': this.supabaseKey,
                    'Authorization': `Bearer ${this.supabaseKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ preferences })
            });
        }
    },

    async getChargesConfig() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/regulatory_charges_config?effective_to=is.null&order=exchange.asc,charge_type.asc,transaction_category.asc,transaction_type.asc`, {
            headers: { 'apikey': this.supabaseKey, 'Authorization': `Bearer ${this.supabaseKey}` }
        });
        return await response.json();
    },

    async expireChargeRow(id, effectiveTo) {
        await fetch(`${this.supabaseUrl}/rest/v1/regulatory_charges_config?id=eq.${id}`, {
            method: 'PATCH',
            headers: { 'apikey': this.supabaseKey, 'Authorization': `Bearer ${this.supabaseKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ effective_to: effectiveTo })
        });
    },

    async insertChargeRows(rows) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/regulatory_charges_config`, {
            method: 'POST',
            headers: { 'apikey': this.supabaseKey, 'Authorization': `Bearer ${this.supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
            body: JSON.stringify(rows)
        });
        var data = await response.json();
        if (!response.ok) {
            console.error('Insert charges failed:', response.status, data);
            throw new Error(data.message || data.details || ('HTTP ' + response.status));
        }
        return data;
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
                    <th style="width:80px;text-align:center;">⚙️</th>
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
    document.getElementById('brokerAccountsList').innerHTML = '';
    brokerAccountCounter = 0;
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
    
    const accounts = await DB.getBrokerAccounts(id);
    document.getElementById('brokerAccountsList').innerHTML = '';
    brokerAccountCounter = 0;
    for (const acc of accounts) {
        await addBrokerAccount(acc.broker_id, acc.account_number, acc.brokerage_rates, acc.charges_inclusive);
    }
    
    document.getElementById('investorModal').classList.add('show');
}

async function addBrokerAccount(selectedBrokerId = '', accountNumber = '', existingRates = null, chargesInclusive = false) {
    const brokers = await DB.getBrokers();
    const index = brokerAccountCounter++;
    
    const selectedBroker = selectedBrokerId ? brokers.find(b => b.id === selectedBrokerId) : null;
    const rates = existingRates || (selectedBroker ? selectedBroker.default_brokerage_rates : {
        equity: { delivery: { pct: 0, max: 20 }, intraday: { pct: 0.03, max: 20 } },
        derivatives: { futures: { pct: 0.03, max: 20 }, options: { flat: 20, max: 0 } }
    });
    
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
                        <div class="form-group"><label>%</label><input type="number" step="0.01" class="eq-del-pct" data-index="${index}" value="${rates.equity?.delivery?.pct !== undefined ? rates.equity.delivery.pct : ''}"></div>
                        <div class="form-group"><label>Max ₹</label><input type="number" step="0.01" class="eq-del-max" data-index="${index}" value="${rates.equity?.delivery?.max !== undefined ? rates.equity.delivery.max : ''}"></div>
                    </div>
                </div>
                <div class="brokerage-section">
                    <span class="brokerage-label">Equity - Intraday</span>
                    <div class="form-row">
                        <div class="form-group"><label>%</label><input type="number" step="0.01" class="eq-intra-pct" data-index="${index}" value="${rates.equity?.intraday?.pct !== undefined ? rates.equity.intraday.pct : ''}"></div>
                        <div class="form-group"><label>Max ₹</label><input type="number" step="0.01" class="eq-intra-max" data-index="${index}" value="${rates.equity?.intraday?.max !== undefined ? rates.equity.intraday.max : ''}"></div>
                    </div>
                </div>
                <div class="brokerage-section">
                    <span class="brokerage-label">Futures</span>
                    <div class="form-row">
                        <div class="form-group"><label>%</label><input type="number" step="0.01" class="fut-pct" data-index="${index}" value="${rates.derivatives?.futures?.pct !== undefined ? rates.derivatives.futures.pct : ''}"></div>
                        <div class="form-group"><label>Max ₹</label><input type="number" step="0.01" class="fut-max" data-index="${index}" value="${rates.derivatives?.futures?.max !== undefined ? rates.derivatives.futures.max : ''}"></div>
                    </div>
                </div>
                <div class="brokerage-section">
                    <span class="brokerage-label">Options</span>
                    <div class="form-row">
                        <div class="form-group"><label>Flat ₹</label><input type="number" step="0.01" class="opt-flat" data-index="${index}" value="${rates.derivatives?.options?.flat !== undefined ? rates.derivatives.options.flat : ''}"></div>
                        <div class="form-group"><label>Max ₹</label><input type="number" step="0.01" class="opt-max" data-index="${index}" value="${rates.derivatives?.options?.max !== undefined ? rates.derivatives.options.max : ''}"></div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.getElementById('brokerAccountsList').insertAdjacentHTML('beforeend', html);
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
}

function removeBrokerAccount(index) {
    const element = document.getElementById(`broker-account-${index}`);
    if (element) element.remove();
}

async function saveInvestor() {
    const data = {
        name: document.getElementById('investorName').value.trim(),
        short_name: document.getElementById('investorShortName').value.trim() || null,
        account_type: document.getElementById('investorAccountType').value,
        email: document.getElementById('investorEmail').value.trim() || null,
        pan: document.getElementById('investorPan').value.trim().toUpperCase() || null,
        phone: document.getElementById('investorPhone').value.trim() || null,
        is_active: document.getElementById('investorStatus').value === 'true'
    };

    if (!data.name) {
        alert('Please enter investor name');
        return;
    }

    if (!data.account_type) {
        alert('Please select account type');
        return;
    }

    const brokerSelects = document.querySelectorAll('.broker-select');
    const brokerAccounts = [];
    
    brokerSelects.forEach((select) => {
        if (select.value) {
            const i = select.getAttribute('data-index');
            brokerAccounts.push({
                broker_id: select.value,
                account_number: document.querySelector(`.account-number[data-index="${i}"]`).value.trim() || null,
                brokerage_rates: {
                    equity: {
                        delivery: {
                            pct: parseFloat(document.querySelector(`.eq-del-pct[data-index="${i}"]`).value),
                            max: parseFloat(document.querySelector(`.eq-del-max[data-index="${i}"]`).value)
                        },
                        intraday: {
                            pct: parseFloat(document.querySelector(`.eq-intra-pct[data-index="${i}"]`).value),
                            max: parseFloat(document.querySelector(`.eq-intra-max[data-index="${i}"]`).value)
                        }
                    },
                    derivatives: {
                        futures: {
                            pct: parseFloat(document.querySelector(`.fut-pct[data-index="${i}"]`).value),
                            max: parseFloat(document.querySelector(`.fut-max[data-index="${i}"]`).value)
                        },
                        options: {
                            flat: parseFloat(document.querySelector(`.opt-flat[data-index="${i}"]`).value),
                            max: parseFloat(document.querySelector(`.opt-max[data-index="${i}"]`).value)
                        }
                    }
                },
                charges_inclusive: document.querySelector(`.charges-inclusive[data-index="${i}"]`).value === 'true',
                is_custom_rates: true
            });
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
                    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
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
                    <th style="width:80px;text-align:center;">⚙️</th>
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

// Compare two records for meaningful changes ───────────────────

var TRACKED_FIELDS = ['company_name','symbol','nse_symbol','nse_script_code',
    'bse_symbol','bse_script_code','lot_size','security_type','asset_class',
    'nse_series','bse_series','fyers_instr_type'];

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

// Fetch ALL rows from a table, bypassing the 1000-row default limit
// by paginating with .range() until we get a partial page
async function fetchAllRows(table, select, orderCol) {
    orderCol = orderCol || 'symbol';
    const BATCH = 1000;
    let all = [], from = 0;
    while (true) {
        const { data, error } = await window.supabaseClient
            .from(table)
            .select(select)
            .order(orderCol, { ascending: true })
            .range(from, from + BATCH - 1);
        if (error) throw error;
        all = all.concat(data || []);
        if (!data || data.length < BATCH) break;
        from += BATCH;
    }
    return all;
}

// Main sync flow ───────────────────────────────────────────────

async function startSync() {
    const btn = document.getElementById('btnSync');
    const preview = document.getElementById('syncPreview');
    const progWrap = document.getElementById('syncProgressWrap');
    const progBar  = document.getElementById('syncProgressBar');
    const progLbl  = document.getElementById('syncProgressLabel');

    btn.disabled = true;
    btn.textContent = '⏳ Fetching CSVs...';
    preview.style.display = 'block';
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
                const diffs = diffRecord(dbMap.get(isin), incoming);
                if (diffs.length > 0) {
                    toUpdate.push({ record: incoming, diffs, existing: dbMap.get(isin) });
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
        progBar.style.background = '#e53e3e';
        console.error(err);
    } finally {
        btn.disabled = false;
        btn.textContent = '⟳ Sync from Fyers';
    }
}

function renderSyncPreview({ toAdd, toUpdate, missing, unchanged }) {
    document.getElementById('pvNew').textContent  = toAdd.length.toLocaleString('en-IN');
    document.getElementById('pvEdit').textContent = toUpdate.length.toLocaleString('en-IN');
    document.getElementById('pvMiss').textContent = missing.length.toLocaleString('en-IN');
    document.getElementById('pvSame').textContent = unchanged.length.toLocaleString('en-IN');

    const changesSection = document.getElementById('changesSection');
    changesSection.style.display = (toUpdate.length + missing.length > 0) ? 'block' : 'none';

    // Changes table
    document.getElementById('editCountLabel').textContent = toUpdate.length;
    const tbody = document.getElementById('changesTbody');
    tbody.innerHTML = '';
    for (const { record, diffs } of toUpdate) {
        for (const d of diffs) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${record.symbol || ''}</strong></td>
                <td style="font-size:10px;color:#718096;">${record.isin}</td>
                <td><span class="change-tag tag-edit">${d.field}</span></td>
                <td style="color:#718096;font-size:11px;">${d.from ?? '—'}</td>
                <td style="color:#2d3748;font-size:11px;">${d.to ?? '—'}</td>`;
            tbody.appendChild(tr);
        }
    }

    // Missing table
    const missingTbody = document.getElementById('missingTbody');
    missingTbody.innerHTML = '';
    for (const r of missing) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${r.symbol||''}</td><td style="font-size:10px;">${r.isin}</td>
            <td>${r.company_name||''}</td><td style="color:#718096;font-size:10px;">No longer in CSV — kept as-is</td>`;
        missingTbody.appendChild(tr);
    }
}

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

        alert(`✓ Done! Added: ${toAdd.length} | Updated: ${toUpdate.length}`);
        _syncPending = null;
        document.getElementById('syncPreview').style.display = 'none';
        await loadSecuritiesStats();
        await loadSecuritiesTable();

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
    document.getElementById('syncPreview').style.display = 'none';
}

// Browse / filter table ────────────────────────────────────────

var _securitiesAll = [];

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

async function loadSecuritiesTable() {
    const tbody = document.getElementById('secTbody');
    setSecLoading(true, 'Loading securities...');
    try {
        // Fetch all rows using paginated helper (bypasses 1000-row default limit)
        const all = await fetchAllRows('securities_db',
            'id,symbol,company_name,isin,nse_symbol,bse_symbol,security_type,asset_class,is_active', 'isin');
        _securitiesAll = all;
        renderSecurities();
    } catch(e) {
        console.warn('Securities table load error', e);
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#718096;padding:20px;">Connect to Supabase to browse securities</td></tr>';
    } finally {
        setSecLoading(false);
    }
}

// renderSecurities kept as alias for pill filter changes triggered before unified is wired
function renderSecurities() { renderUnified(); }

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
        FUTURES:'#fef3c7:#78350f', OPTIONS:'#dbeafe:#1e40af'
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
    if (q) console.log('[renderUnified] Search:', q, '| CM rows:', (_securitiesAll||[]).length, '| FO rows:', (_foAll||[]).length);
    const fTypes  = getMsValues('msType');
    const fExch   = getMsValues('msExch');
    const fClass  = getMsValues('msClass');

    // Require at least a search term OR at least one filter to render
    const hasFilter = q.length >= 1 || fTypes.size > 0 || fExch.size > 0 || fClass.size > 0;
    if (!hasFilter) {
        _uniRows = [];
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#a0aec0;padding:32px;font-size:12px;">' +
            'Search above, or select a Type, Asset Class or Exchange filter to browse</td></tr>';
        renderUniPager(0, 0);
        return;
    }

    // Build unified row list from both datasets
    const cmRows = (_securitiesAll || []).map(r => ({
        symbol:      r.symbol || '',
        name:        r.company_name || '',
        type:        r.security_type || '',
        asset_class: r.asset_class || '',
        underlying:  '',
        expiry_dt:   null,
        lot_size:    r.lot_size || '',
        exchanges:   (r.nse_symbol ? 'NSE' : '') + (r.nse_symbol && r.bse_symbol ? ' ' : '') + (r.bse_symbol ? 'BSE' : ''),
        is_active:   r.is_active,
        isin:        r.isin || '',
        _src:        'cm'
    }));

    const foRows = (_foAll || []).map(r => ({
        symbol:      r.symbol || '',
        name:        r.instrument_name || '',
        type:        r.instrument_type || '',
        asset_class: r.exchange === 'MCX' ? 'Commodity' : 'Indian Equity',
        underlying:  r.underlying_symbol || '',
        expiry_dt:   r.expiry_date ? new Date(r.expiry_date) : null,
        lot_size:    r.lot_size || '',
        exchanges:   r.exchange || '',
        is_active:   r.is_active,
        isin:        '',
        _src:        'fo'
    }));

    let rows = [...cmRows, ...foRows];

    if (q) rows = rows.filter(r =>
        r.symbol.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.underlying.toLowerCase().includes(q) ||
        r.isin.toLowerCase().startsWith(q));

    if (fTypes.size) rows = rows.filter(r => fTypes.has(r.type));

    if (fExch.size) rows = rows.filter(r => {
        if (r._src === 'cm') {
            return (fExch.has('NSE') && r.exchanges.includes('NSE')) ||
                   (fExch.has('BSE') && r.exchanges.includes('BSE'));
        }
        return fExch.has(r.exchanges);
    });

    if (fClass.size) rows = rows.filter(r => fClass.has(r.asset_class));

    _uniRows = rows;

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#718096;padding:24px;font-size:12px;">No results found</td></tr>';
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
        return '<tr>' +
            '<td><strong style="font-size:12px;">' + r.symbol + '</strong></td>' +
            '<td style="font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + r.name + '</td>' +
            '<td>' + _typeBadge(r.type) + '</td>' +
            '<td style="font-size:11px;color:#4a5568;">' + (r.asset_class || '<span style="color:#cbd5e0;">—</span>') + '</td>' +
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
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#718096;padding:20px;">No securities found</td></tr>';
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
        tr.innerHTML = `<td colspan="7" style="text-align:center;font-size:11px;color:#718096;padding:8px;">
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
    const placeholders = { msType: 'All Types', msClass: 'All Asset Classes', msExch: 'All Exchanges' };
    const multiLabels  = { msType: 'types', msClass: 'classes', msExch: 'exchanges' };
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

var _foAll = [];
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
        _foAll = await fetchAllRows('securities_nfo',
            'id,symbol,instrument_name,exchange,instrument_type,underlying_symbol,' +
            'expiry_date,strike_price,option_type,lot_size,is_active');
        renderUnified();
    } catch(e) {
        console.warn('FO table load error', e);
        document.getElementById('foTbody').innerHTML =
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
    const preview  = document.getElementById('foSyncPreview');
    const progWrap = document.getElementById('foProgressWrap');
    const progBar  = document.getElementById('foProgressBar');
    const progLbl  = document.getElementById('foProgressLabel');
    preview.style.display  = 'block';
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

        // ── 2. Filter FUTURES only (instr_type == 11) ───────────────
        function parseRow(cols, exchCode) {
            if (!cols || cols.length < 17) return null;
            const optType = (cols[16] || '').trim();
            if (optType !== 'XX') return null;   // futures only (XX = future, CE/PE = options)
            // instrType: 11=index futures, 13=stock futures, 14=options (already excluded above)

            const symbol    = (cols[9]  || '').trim();
            const exEpoch   = parseInt(cols[8]);
            const exDate    = isNaN(exEpoch) ? null
                            : new Date(exEpoch * 1000).toISOString().slice(0, 10);
            const isActive  = exDate ? (new Date(exDate) >= today) : false;
            const strike    = null;   // futures never have a strike

            return {
                symbol,
                instrument_name:   (cols[1]  || '').trim(),
                exchange:          exchCode,
                instrument_type:   'FUTURES',
                underlying_symbol: (cols[13] || '').trim(),
                expiry_date:       exDate,
                strike_price:      null,
                option_type:       null,
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

        _foCsvMap = new Map(csvRecords.map(r => [r.symbol, r]));

        progBar.style.width = '70%';
        progLbl.textContent = 'Loading DB...';

        // ── 3. Load existing DB ─────────────────────────────────────
        const existing = await fetchAllRows('securities_nfo', '*');
        _foDbMap = new Map(existing.map(r => [r.symbol, r]));

        progBar.style.width = '88%';
        progLbl.textContent = 'Computing diff...';

        // ── 4. Diff ─────────────────────────────────────────────────
        _foToAdd       = [];
        _foToUpdate    = [];
        _foToDeactivate = [];

        // New or changed contracts
        for (const [sym, csv] of _foCsvMap) {
            const db = _foDbMap.get(sym);
            if (!db) {
                _foToAdd.push(csv);
            } else {
                const diffs = diffFORecord(db, csv);
                if (diffs.length) _foToUpdate.push({ symbol: sym, diffs, record: csv });
            }
        }

        // Contracts in DB but not in CSV → deactivate if still marked active
        for (const [sym, db] of _foDbMap) {
            if (!_foCsvMap.has(sym) && db.is_active) {
                _foToDeactivate.push(db);
            }
        }

        progBar.style.width = '100%';
        progLbl.textContent = 'Done.';

        // ── 5. Show preview ─────────────────────────────────────────
        document.getElementById('foPvNew').textContent  = _foToAdd.length.toLocaleString('en-IN');
        document.getElementById('foPvEdit').textContent = _foToUpdate.length.toLocaleString('en-IN');
        document.getElementById('foPvMiss').textContent = _foToDeactivate.length.toLocaleString('en-IN');
        document.getElementById('foPvSame').textContent =
            (_foCsvMap.size - _foToAdd.length - _foToUpdate.length).toLocaleString('en-IN');

        document.getElementById('btnFOCommit').disabled =
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
    check('instrument_name',   db.instrument_name,   csv.instrument_name);
    check('underlying_symbol', db.underlying_symbol, csv.underlying_symbol);
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
    const btn = document.getElementById('btnFOCommit');
    btn.disabled = true;
    btn.textContent = '⏳ Committing...';
    setFOLoading(true, 'Committing F&O contracts...');

    const progWrap = document.getElementById('foProgressWrap');
    const progBar  = document.getElementById('foProgressBar');
    const progLbl  = document.getElementById('foProgressLabel');
    progWrap.style.display = 'block';
    progLbl.style.display  = 'block';
    progBar.style.width    = '5%';

    try {
        const BATCH = 200;
        let done = 0;
        const total = _foToAdd.length + _foToUpdate.length + _foToDeactivate.length;

        // ── Upsert new + updated ───────────────────────────────────
        const toUpsert = [
            ..._foToAdd,
            ..._foToUpdate.map(u => u.record)
        ];
        for (let i = 0; i < toUpsert.length; i += BATCH) {
            const chunk = toUpsert.slice(i, i + BATCH);
            const { error } = await window.supabaseClient
                .from('securities_nfo')
                .upsert(chunk, { onConflict: 'symbol' });
            if (error) throw error;
            done += chunk.length;
            progBar.style.width = Math.round(10 + (done / total) * 80) + '%';
            progLbl.textContent = 'Committed ' + done.toLocaleString('en-IN') + ' of ' + total.toLocaleString('en-IN') + '...';
        }

        // ── Mark expired contracts inactive ────────────────────────
        for (let i = 0; i < _foToDeactivate.length; i += BATCH) {
            const chunk = _foToDeactivate.slice(i, i + BATCH);
            const symbols = chunk.map(r => r.symbol);
            const { error } = await window.supabaseClient
                .from('securities_nfo')
                .update({ is_active: false })
                .in('symbol', symbols);
            if (error) throw error;
            done += chunk.length;
            progBar.style.width = Math.round(10 + (done / total) * 80) + '%';
            progLbl.textContent = 'Deactivating expired: ' + done.toLocaleString('en-IN') + ' of ' + total.toLocaleString('en-IN') + '...';
        }

        progBar.style.width = '100%';
        progLbl.textContent = 'Done.';
        localStorage.setItem('wms_last_fo_sync', new Date().toISOString());

        await loadFOStats();

        // Reload FO data into memory and re-render
        _foAll = await fetchAllRows('securities_nfo',
            'id,symbol,instrument_name,exchange,instrument_type,underlying_symbol,' +
            'expiry_date,strike_price,option_type,lot_size,is_active');
        renderUnified();

        // Reset preview
        document.getElementById('foSyncPreview').style.display = 'none';
        _foCsvMap = null; _foDbMap = null;

    } catch(e) {
        console.error('FO commit error', e);
        progLbl.textContent = 'Error: ' + e.message;
        progLbl.style.color = '#dc2626';
        btn.disabled = false;
        btn.textContent = '✓ Commit to Database';
    } finally {
        setFOLoading(false);
        progWrap.style.display = 'none';
        progLbl.style.display  = 'none';
    }
}

function cancelFOSync() {
    document.getElementById('foSyncPreview').style.display = 'none';
    _foCsvMap = null; _foDbMap = null;
    document.getElementById('btnFOCommit').disabled = true;
    document.getElementById('btnFOSync').disabled   = false;
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
var CHARGE_TYPES = ['STT', 'EXCHANGE_CHARGES', 'SEBI_CHARGES', 'STAMP_DUTY'];
var CHARGE_LABELS = {
    'STT': 'STT/CTT',
    'EXCHANGE_CHARGES': 'Transaction Charges',
    'SEBI_CHARGES': 'SEBI Charges',
    'STAMP_DUTY': 'Stamp Charges'
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

function formatDateShort(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return ('0' + d.getDate()).slice(-2) + '-' + months[d.getMonth()] + '-' + String(d.getFullYear()).slice(-2);
}

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
