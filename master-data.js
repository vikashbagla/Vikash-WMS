// Configuration
const SUPABASE_URL = 'https://lynvrwteylgpwlwbslse.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5bnZyd3RleWxncHdsd2JzbHNlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwOTI4NDMsImV4cCI6MjA4NTY2ODg0M30.zHMouEjak_Fpd9LBqHbSOifVfSCZ0U8AqrX94C9oKXc';

// State
let investors = [];
let brokers = [];
let currentUser = null;
let editingInvestorId = null;
let editingBrokerId = null;

// Initialize
window.addEventListener('DOMContentLoaded', () => {
    // Check if user is logged in
    const savedUser = localStorage.getItem('wms_user');
    if (!savedUser) {
        window.location.href = 'index.html';
        return;
    }
    
    currentUser = JSON.parse(savedUser);
    
    // Load data
    loadInvestors();
    loadBrokers();
    loadPreferences();
});

// ============================================================================
// TAB SWITCHING
// ============================================================================

function switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');
}

// ============================================================================
// INVESTORS
// ============================================================================

async function loadInvestors() {
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/investors?select=*&order=name.asc`, {
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            }
        });

        investors = await response.json();
        renderInvestors();
    } catch (error) {
        console.error('Error loading investors:', error);
        alert('Failed to load investors. Please refresh the page.');
    }
}

function renderInvestors() {
    const loadingState = document.getElementById('investorsLoading');
    const emptyState = document.getElementById('investorsEmpty');
    const grid = document.getElementById('investorsGrid');

    loadingState.style.display = 'none';

    if (investors.length === 0) {
        emptyState.style.display = 'block';
        grid.style.display = 'none';
        return;
    }

    emptyState.style.display = 'none';
    grid.style.display = 'grid';

    const searchTerm = document.getElementById('investorSearch').value.toLowerCase();
    const filteredInvestors = investors.filter(inv => 
        inv.name.toLowerCase().includes(searchTerm) ||
        (inv.email && inv.email.toLowerCase().includes(searchTerm))
    );

    grid.innerHTML = filteredInvestors.map(investor => {
        const initials = investor.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        const statusClass = investor.is_active ? 'status-active' : 'status-inactive';
        const statusText = investor.is_active ? 'Active' : 'Inactive';

        return `
            <div class="card">
                <div class="card-header">
                    <div class="card-avatar">${initials}</div>
                    <div class="card-info">
                        <h3>${investor.name}</h3>
                        <p>${investor.email || 'No email'}</p>
                    </div>
                    <div class="card-actions">
                        <button class="btn-icon" onclick="editInvestor('${investor.id}')" title="Edit">✏️</button>
                        <button class="btn-icon" onclick="deleteInvestor('${investor.id}')" title="Delete">🗑️</button>
                    </div>
                </div>
                <div class="card-details">
                    <div class="detail-row">
                        <span class="detail-label">Phone</span>
                        <span class="detail-value">${investor.phone || 'Not set'}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">PAN</span>
                        <span class="detail-value">${investor.pan || 'Not set'}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Account Type</span>
                        <span class="detail-value">${investor.account_type || 'Not set'}</span>
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
    renderInvestors();
}

function openAddInvestorModal() {
    editingInvestorId = null;
    document.getElementById('investorModalTitle').textContent = 'Add Investor';
    document.getElementById('investorForm').reset();
    document.getElementById('investorId').value = '';
    document.getElementById('investorStatus').value = 'true';
    document.getElementById('investorModal').classList.add('show');
}

function editInvestor(id) {
    const investor = investors.find(inv => inv.id === id);
    if (!investor) return;

    editingInvestorId = id;
    document.getElementById('investorModalTitle').textContent = 'Edit Investor';
    document.getElementById('investorId').value = investor.id;
    document.getElementById('investorName').value = investor.name;
    document.getElementById('investorEmail').value = investor.email || '';
    document.getElementById('investorPhone').value = investor.phone || '';
    document.getElementById('investorPan').value = investor.pan || '';
    document.getElementById('investorAccountType').value = investor.account_type || '';
    document.getElementById('investorStatus').value = investor.is_active ? 'true' : 'false';
    document.getElementById('investorNotes').value = investor.notes || '';
    document.getElementById('investorModal').classList.add('show');
}

async function saveInvestor() {
    const name = document.getElementById('investorName').value.trim();
    const email = document.getElementById('investorEmail').value.trim();
    const phone = document.getElementById('investorPhone').value.trim();
    const pan = document.getElementById('investorPan').value.trim().toUpperCase();
    const accountType = document.getElementById('investorAccountType').value.trim();
    const status = document.getElementById('investorStatus').value === 'true';
    const notes = document.getElementById('investorNotes').value.trim();

    if (!name) {
        alert('Please enter investor name');
        return;
    }

    const investorData = {
        name,
        email: email || null,
        phone: phone || null,
        pan: pan || null,
        account_type: accountType || null,
        is_active: status,
        notes: notes || null
    };

    try {
        if (editingInvestorId) {
            // Update existing investor
            const response = await fetch(`${SUPABASE_URL}/rest/v1/investors?id=eq.${editingInvestorId}`, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify(investorData)
            });

            if (!response.ok) throw new Error('Update failed');
        } else {
            // Add new investor
            const response = await fetch(`${SUPABASE_URL}/rest/v1/investors`, {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify(investorData)
            });

            if (!response.ok) throw new Error('Insert failed');
        }

        closeInvestorModal();
        loadInvestors();
    } catch (error) {
        console.error('Error saving investor:', error);
        alert('Failed to save investor. Please try again.');
    }
}

async function deleteInvestor(id) {
    const investor = investors.find(inv => inv.id === id);
    if (!investor) return;

    if (!confirm(`Are you sure you want to delete ${investor.name}?`)) {
        return;
    }

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/investors?id=eq.${id}`, {
            method: 'DELETE',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            }
        });

        if (!response.ok) throw new Error('Delete failed');

        loadInvestors();
    } catch (error) {
        console.error('Error deleting investor:', error);
        alert('Failed to delete investor. They may have associated data.');
    }
}

function closeInvestorModal() {
    document.getElementById('investorModal').classList.remove('show');
    document.getElementById('investorForm').reset();
    editingInvestorId = null;
}

// ============================================================================
// BROKERS
// ============================================================================

async function loadBrokers() {
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/brokers?select=*&order=name.asc`, {
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            }
        });

        brokers = await response.json();
        renderBrokers();
    } catch (error) {
        console.error('Error loading brokers:', error);
        alert('Failed to load brokers. Please refresh the page.');
    }
}

function renderBrokers() {
    const loadingState = document.getElementById('brokersLoading');
    const emptyState = document.getElementById('brokersEmpty');
    const grid = document.getElementById('brokersGrid');

    loadingState.style.display = 'none';

    if (brokers.length === 0) {
        emptyState.style.display = 'block';
        grid.style.display = 'none';
        return;
    }

    emptyState.style.display = 'none';
    grid.style.display = 'grid';

    const searchTerm = document.getElementById('brokerSearch').value.toLowerCase();
    const filteredBrokers = brokers.filter(broker => 
        broker.name.toLowerCase().includes(searchTerm) ||
        (broker.broker_code && broker.broker_code.toLowerCase().includes(searchTerm))
    );

    grid.innerHTML = filteredBrokers.map(broker => {
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
                        <button class="btn-icon" onclick="editBroker('${broker.id}')" title="Edit">✏️</button>
                        <button class="btn-icon" onclick="deleteBroker('${broker.id}')" title="Delete">🗑️</button>
                    </div>
                </div>
                <div class="card-details">
                    <div class="detail-row">
                        <span class="detail-label">Website</span>
                        <span class="detail-value">${broker.website ? `<a href="${broker.website}" target="_blank" style="color: #667eea;">Visit</a>` : 'Not set'}</span>
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
    renderBrokers();
}

function openAddBrokerModal() {
    editingBrokerId = null;
    document.getElementById('brokerModalTitle').textContent = 'Add Broker';
    document.getElementById('brokerForm').reset();
    document.getElementById('brokerId').value = '';
    document.getElementById('brokerStatus').value = 'true';
    document.getElementById('brokerModal').classList.add('show');
}

function editBroker(id) {
    const broker = brokers.find(b => b.id === id);
    if (!broker) return;

    editingBrokerId = id;
    document.getElementById('brokerModalTitle').textContent = 'Edit Broker';
    document.getElementById('brokerId').value = broker.id;
    document.getElementById('brokerName').value = broker.name;
    document.getElementById('brokerCode').value = broker.broker_code || '';
    document.getElementById('brokerWebsite').value = broker.website || '';
    document.getElementById('brokerStatus').value = broker.is_active ? 'true' : 'false';
    document.getElementById('brokerNotes').value = broker.notes || '';
    document.getElementById('brokerModal').classList.add('show');
}

async function saveBroker() {
    const name = document.getElementById('brokerName').value.trim();
    const code = document.getElementById('brokerCode').value.trim().toUpperCase();
    const website = document.getElementById('brokerWebsite').value.trim();
    const status = document.getElementById('brokerStatus').value === 'true';
    const notes = document.getElementById('brokerNotes').value.trim();

    if (!name) {
        alert('Please enter broker name');
        return;
    }

    const brokerData = {
        name,
        broker_code: code || null,
        website: website || null,
        is_active: status,
        notes: notes || null,
        // Default brokerage rates structure
        default_brokerage_rates: {
            equity: {
                delivery: { pct: 0, max: 20 },
                intraday: { pct: 0.03, max: 20 }
            },
            derivatives: {
                futures: { pct: 0.03, max: 20 },
                options: { flat: 20, max: 0 }
            }
        },
        default_charges_inclusive: false
    };

    try {
        if (editingBrokerId) {
            // Update existing broker
            const response = await fetch(`${SUPABASE_URL}/rest/v1/brokers?id=eq.${editingBrokerId}`, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify(brokerData)
            });

            if (!response.ok) throw new Error('Update failed');
        } else {
            // Add new broker
            const response = await fetch(`${SUPABASE_URL}/rest/v1/brokers`, {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify(brokerData)
            });

            if (!response.ok) throw new Error('Insert failed');
        }

        closeBrokerModal();
        loadBrokers();
    } catch (error) {
        console.error('Error saving broker:', error);
        alert('Failed to save broker. Please try again.');
    }
}

async function deleteBroker(id) {
    const broker = brokers.find(b => b.id === id);
    if (!broker) return;

    if (!confirm(`Are you sure you want to delete ${broker.name}?`)) {
        return;
    }

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/brokers?id=eq.${id}`, {
            method: 'DELETE',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            }
        });

        if (!response.ok) throw new Error('Delete failed');

        loadBrokers();
    } catch (error) {
        console.error('Error deleting broker:', error);
        alert('Failed to delete broker. They may have associated data.');
    }
}

function closeBrokerModal() {
    document.getElementById('brokerModal').classList.remove('show');
    document.getElementById('brokerForm').reset();
    editingBrokerId = null;
}

// ============================================================================
// PREFERENCES
// ============================================================================

function loadPreferences() {
    if (!currentUser || !currentUser.preferences) return;

    const prefs = currentUser.preferences;
    
    document.getElementById('numberFormat').value = prefs.number_format || 'indian';
    document.getElementById('currencySymbol').value = prefs.currency_symbol || '₹';
    document.getElementById('dateFormat').value = prefs.date_format || 'dd-mmm-yy';
    document.getElementById('decimalPlaces').value = prefs.decimal_places || 2;
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
        theme: document.getElementById('theme').value,
        default_view: document.getElementById('defaultView').value,
        financial_year_start: parseInt(document.getElementById('financialYearStart').value)
    };

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${currentUser.id}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation'
            },
            body: JSON.stringify({ preferences })
        });

        if (!response.ok) throw new Error('Update failed');

        const updatedUsers = await response.json();
        if (updatedUsers && updatedUsers.length > 0) {
            currentUser = updatedUsers[0];
            localStorage.setItem('wms_user', JSON.stringify(currentUser));
            alert('Preferences saved successfully!');
        }
    } catch (error) {
        console.error('Error saving preferences:', error);
        alert('Failed to save preferences. Please try again.');
    }
}

// Close modals on background click
document.getElementById('investorModal').addEventListener('click', (e) => {
    if (e.target.id === 'investorModal') {
        closeInvestorModal();
    }
});

document.getElementById('brokerModal').addEventListener('click', (e) => {
    if (e.target.id === 'brokerModal') {
        closeBrokerModal();
    }
});
