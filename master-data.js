// Configuration
// SUPABASE_URL defined in app.html
// SUPABASE_ANON_KEY defined in app.html

// State
let brokerAccountCounter = 0;
let editingInvestorId = null;
let editingBrokerId = null;

// Universal Data Layer
const DB = {
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
    }
};

// Initialize - callable from app.html when module is loaded
function initMasterData() {
    DB.init();
    loadInvestors();
    loadBrokers();
    loadPreferences();
    loadSecuritiesStats();
}

// Also support direct page load
window.addEventListener('DOMContentLoaded', initMasterData);

// Tab switching
function switchTab(event, tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById(`${tabName}-tab`).classList.add('active');
    if (tabName === 'securities') {
        loadSecuritiesStats();
        if (!_secTableLoaded) { _secTableLoaded = true; loadSecuritiesTable(); }
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
                    <th style="width:70px;">Actions</th>
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
                            <td><strong>${inv.name}</strong></td>
                            <td style="color:#718096;">${inv.email || '—'}</td>
                            <td>${inv.account_type || '—'}</td>
                            <td>${mappedBrokers.length > 0 ? mappedBrokers.map(b => `<span class="broker-tag">${b}</span>`).join('') : '<span style="color:#718096;">—</span>'}</td>
                            <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                            <td>
                                <button class="btn-icon" onclick="handleEditInvestor('${inv.id}')" title="Edit">✏️</button>
                                <button class="btn-icon" onclick="handleDeleteInvestor('${inv.id}')" title="Delete">🗑️</button>
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
                    <th style="width:70px;">Actions</th>
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
                            <td>
                                <button class="btn-icon" onclick="handleEditBroker('${broker.id}')" title="Edit">✏️</button>
                                <button class="btn-icon" onclick="handleDeleteBroker('${broker.id}')" title="Delete">🗑️</button>
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
        default_charges_inclusive: document.getElementById('chargesInclusive').value === 'true'
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
const COL = { FYTOKEN:0, NAME:1, INSTR_TYPE:2, LOT_SIZE:3, TICK:4, ISIN:5,
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

let _syncPending = null; // { toAdd:[], toUpdate:[], missing:[], unchanged:[] }

// Compare two records for meaningful changes ───────────────────

const TRACKED_FIELDS = ['company_name','symbol','nse_symbol','nse_script_code',
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
    // broker_tokens diff (simple JSON compare)
    const tokA = JSON.stringify(existing.broker_tokens || {});
    const tokB = JSON.stringify(incoming.broker_tokens || {});
    if (tokA !== tokB) diffs.push({ field: 'broker_tokens', from: '(json)', to: '(updated)' });
    return diffs;
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

        // Load existing DB records
        const { data: existing, error } = await window.supabaseClient
            .from('securities_db').select('*');
        if (error) throw error;

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

let _securitiesAll = [];

async function loadSecuritiesStats() {
    try {
        const { count: total } = await window.supabaseClient
            .from('securities_db').select('*', { count: 'exact', head: true });
        const { count: active } = await window.supabaseClient
            .from('securities_db').select('*', { count: 'exact', head: true })
            .eq('is_active', true);
        document.getElementById('statTotal').textContent  = (total  || 0).toLocaleString('en-IN');
        document.getElementById('statActive').textContent = (active || 0).toLocaleString('en-IN');
        const ls = localStorage.getItem('wms_last_securities_sync');
        document.getElementById('statLastSync').textContent = ls
            ? new Date(ls).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' })
            : 'Never';
    } catch(e) { console.warn('Stats load error', e); }
}

async function loadSecuritiesTable() {
    const tbody = document.getElementById('secTbody');
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#718096;padding:20px;">Loading securities...</td></tr>';
    try {
        // Fetch all rows in batches of 5000 (Supabase default max per request)
        let all = [], from = 0, batchSize = 5000;
        while (true) {
            const { data, error } = await window.supabaseClient
                .from('securities_db')
                .select('id,symbol,company_name,isin,nse_symbol,bse_symbol,security_type,asset_class,is_active')
                .order('symbol', { ascending: true })
                .range(from, from + batchSize - 1);
            if (error) throw error;
            all = all.concat(data || []);
            if (!data || data.length < batchSize) break;
            from += batchSize;
        }
        _securitiesAll = all;
        renderSecurities();
    } catch(e) {
        console.warn('Securities table load error', e);
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#718096;padding:20px;">Connect to Supabase to browse securities</td></tr>';
    }
}

function renderSecurities() {
    if (!_securitiesAll.length) return; // not loaded yet
    const q       = (document.getElementById('secSearch')?.value || '').trim().toLowerCase();
    const fTypes  = getMsValues('msType');
    const fClasses= getMsValues('msClass');
    const fExch   = document.getElementById('secFilterExch')?.value || '';

    let rows = _securitiesAll;
    if (q)              rows = rows.filter(r =>
                            (r.symbol||'').toLowerCase().includes(q) ||
                            (r.company_name||'').toLowerCase().includes(q) ||
                            (r.isin||'').toLowerCase().startsWith(q));
    if (fTypes.size)    rows = rows.filter(r => fTypes.has(r.security_type));
    if (fClasses.size)  rows = rows.filter(r => fClasses.has(r.asset_class));
    if (fExch === 'nse') rows = rows.filter(r => r.nse_symbol);
    if (fExch === 'bse') rows = rows.filter(r => r.bse_symbol);

    renderRows(rows, document.getElementById('secTbody'));
}

// Shared row renderer
const _typeColors = {
    EQUITY:'#c6f6d5:#22543d', EQUITY_SME:'#bee3f8:#2c5282',
    ETF:'#e9d8fd:#553c9a',    MF:'#e9d8fd:#553c9a',
    SGB:'#fefcbf:#744210',    REIT:'#fed7d7:#822727',
    INVIT:'#ffe4c4:#7b341e',  GOVT_BOND:'#e2e8f0:#4a5568',
    NCD:'#e2e8f0:#4a5568',    PREF_SHARE:'#c6f6d5:#22543d',
    RIGHTS:'#fce8e8:#822727', WARRANT:'#fce8e8:#822727'
};
function _typeBadge(t) {
    const [bg, fg] = (_typeColors[t]||'#e2e8f0:#4a5568').split(':');
    return `<span style="background:${bg};color:${fg};padding:1px 7px;border-radius:10px;font-size:10px;font-weight:600;">${t}</span>`;
}
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

// Load table when securities tab is first opened
let _secTableLoaded = false;

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
    const id = pill.dataset.ms;
    updateMsLabel(id);
    renderSecurities();
}

// Update the trigger button label to reflect selection state
function updateMsLabel(id) {
    const values  = getMsValues(id);
    const label   = document.getElementById(id + 'Label');
    const trigger = document.getElementById(id + 'Trigger');
    if (!label) return;
    const placeholder = id === 'msType' ? 'All Types' : 'All Asset Classes';
    if (values.size === 0) {
        label.textContent = placeholder;
        trigger.classList.remove('active');
    } else if (values.size === 1) {
        // Show the pill label text (may be abbreviated e.g. "Intl Equity")
        const pill = document.querySelector(`#${id}Dropdown .ms-pill.on`);
        label.textContent = pill ? pill.textContent : [...values][0];
        trigger.classList.add('active');
    } else {
        label.textContent = `${values.size} types`;
        if (id === 'msClass') label.textContent = `${values.size} classes`;
        trigger.classList.add('active');
    }
}

// Clear all pills for a given ms id
function clearMs(id) {
    const dd = document.getElementById(id + 'Dropdown');
    if (!dd) return;
    dd.querySelectorAll('.ms-pill.on').forEach(p => p.classList.remove('on'));
    updateMsLabel(id);
    renderSecurities();
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

// Close when clicking outside
document.addEventListener('click', e => {
    if (!e.target.closest('.ms-wrap')) {
        document.querySelectorAll('.ms-dropdown.open').forEach(d => d.classList.remove('open'));
        document.querySelectorAll('.ms-trigger.open').forEach(t => t.classList.remove('open'));
    }
});
