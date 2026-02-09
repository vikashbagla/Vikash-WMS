// Configuration
const SUPABASE_URL = 'https://lynvrwteylgpwlwbslse.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5bnZyd3RleWxncHdsd2JzbHNlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwOTI4NDMsImV4cCI6MjA4NTY2ODg0M30.zHMouEjak_Fpd9LBqHbSOifVfSCZ0U8AqrX94C9oKXc';

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

// Initialize
window.addEventListener('DOMContentLoaded', () => {
    DB.init();
    loadInvestors();
    loadBrokers();
    loadPreferences();
});

// Tab switching
function switchTab(event, tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById(`${tabName}-tab`).classList.add('active');
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

    grid.innerHTML = filtered.map(inv => {
        const initials = inv.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        const statusClass = inv.is_active ? 'status-active' : 'status-inactive';
        const statusText = inv.is_active ? 'Active' : 'Inactive';
        
        const invAccounts = accounts.filter(acc => acc.investor_id === inv.id);
        const mappedBrokers = invAccounts.map(acc => {
            const broker = brokers.find(b => b.id === acc.broker_id);
            return broker ? broker.name : 'Unknown';
        });

        return `
            <div class="card">
                <div class="card-header">
                    <div class="card-avatar">${initials}</div>
                    <div class="card-info">
                        <h3>${inv.name}</h3>
                        <p>${inv.email || 'No email'}</p>
                    </div>
                    <div class="card-actions">
                        <button class="btn-icon" onclick="handleEditInvestor('${inv.id}')" title="Edit">✏️</button>
                        <button class="btn-icon" onclick="handleDeleteInvestor('${inv.id}')" title="Delete">🗑️</button>
                    </div>
                </div>
                <div class="card-details">
                    <div class="detail-row">
                        <span class="detail-label">Type</span>
                        <span class="detail-value">${inv.account_type || 'Not set'}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Brokers</span>
                        <div class="broker-tags">
                            ${mappedBrokers.length > 0 ? mappedBrokers.map(b => `<span class="broker-tag">${b}</span>`).join('') : '<span style="color:#718096;font-size:13px;">None</span>'}
                        </div>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Status</span>
                        <span class="status-badge ${statusClass}">${statusText}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
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

    grid.innerHTML = filtered.map(broker => {
        const initials = broker.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        const statusClass = broker.is_active ? 'status-active' : 'status-inactive';
        const statusText = broker.is_active ? 'Active' : 'Inactive';

        return `
            <div class="card">
                <div class="card-header">
                    <div class="card-avatar">${initials}</div>
                    <div class="card-info">
                        <h3>${broker.name}</h3>
                        <p>${broker.broker_code || 'No code'}</p>
                    </div>
                    <div class="card-actions">
                        <button class="btn-icon" onclick="handleEditBroker('${broker.id}')" title="Edit">✏️</button>
                        <button class="btn-icon" onclick="handleDeleteBroker('${broker.id}')" title="Delete">🗑️</button>
                    </div>
                </div>
                <div class="card-details">
                    <div class="detail-row">
                        <span class="detail-label">Website</span>
                        <span class="detail-value">${broker.website ? `<a href="${broker.website}" target="_blank" style="color:#667eea;">Visit</a>` : 'Not set'}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Status</span>
                        <span class="status-badge ${statusClass}">${statusText}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
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
