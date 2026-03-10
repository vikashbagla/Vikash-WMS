// ============================================================================
// WMS UTILITIES - Number Formatting & Helpers
// ============================================================================

// Get user's display unit preference
function getDisplayUnit() {
    const user = window.currentUser;
    if (user && user.preferences) {
        // DB stores as 'amount_display', fall back to 'display_unit' for compatibility
        const unit = user.preferences.amount_display || user.preferences.display_unit;
        if (unit) {
            console.log('✅ Display unit:', unit);
            return unit;
        }
    }
    console.warn('⚠️ No display unit in preferences, defaulting to lakhs. Preferences:', user ? user.preferences : 'no user');
    return 'lakhs';
}

// Get divisor and suffix based on unit
function getUnitConfig(unit) {
    const configs = {
        'thousands': { divisor: 1000, suffix: "'000", comma: 'international' },
        'lakhs': { divisor: 100000, suffix: 'L', comma: 'indian' },
        'millions': { divisor: 1000000, suffix: 'M', comma: 'international' },
        'crores': { divisor: 10000000, suffix: 'Cr', comma: 'indian' }
    };
    return configs[unit] || configs['lakhs'];
}

// Format number based on comma style
function formatWithCommas(num, commaStyle) {
    const numStr = num.toFixed(2);
    const [integer, decimal] = numStr.split('.');
    
    let formatted;
    if (commaStyle === 'indian') {
        // Indian style: ##,##,###.##
        let lastThree = integer.substring(integer.length - 3);
        const otherNumbers = integer.substring(0, integer.length - 3);
        
        if (otherNumbers !== '') {
            lastThree = ',' + lastThree;
        }
        formatted = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + lastThree;
    } else {
        // International style: #,###,###.##
        formatted = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    
    return formatted + '.' + decimal;
}

// Format price with display unit (NO ₹ SYMBOL - only for actual prices, not converted)
const formatPrice = (value, applyUnit = false) => {
    if (value === null || value === undefined || isNaN(value)) return '0.00';
    
    if (applyUnit) {
        // For values (apply display unit)
        const unit = getDisplayUnit();
        const config = getUnitConfig(unit);
        const convertedValue = value / config.divisor;
        return formatWithCommas(convertedValue, config.comma);
    } else {
        // For actual prices (always in rupees, no conversion)
        return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
};

// Format amount with display unit and negative handling (NO ₹ SYMBOL)
// Rule: zero amounts display as '-' (immediate visual indicator of no value)
const formatAmount = (value) => {
    if (value === null || value === undefined || isNaN(value) || value === 0) return '-';
    
    const unit = getDisplayUnit();
    const config = getUnitConfig(unit);
    const convertedValue = Math.abs(value) / config.divisor;
    
    if (value < 0) {
        return '(' + formatWithCommas(convertedValue, config.comma) + ')';
    }
    return formatWithCommas(convertedValue, config.comma);
};

// Get unit label for column headers
const getUnitLabel = () => {
    const unit = getDisplayUnit();
    const config = getUnitConfig(unit);
    return config.suffix;
};

// Get full description for the portfolio title e.g. "₹ '000" or "₹ Lakhs"
const getUnitDescription = () => {
    const unit = getDisplayUnit();
    const descriptions = {
        'thousands': "₹ '000",
        'lakhs':     '₹ Lakhs',
        'millions':  '₹ Millions',
        'crores':    '₹ Crores'
    };
    return descriptions[unit] || '₹ Lakhs';
};

// Format quantity (0 decimals)
// Rule: zero quantities display as '-' (consistent with formatAmount)
const formatQuantity = (value) => {
    if (value === null || value === undefined || isNaN(value) || value === 0) return '-';
    return Math.round(value).toLocaleString('en-IN');
};

// Format lots (1 decimal)
const formatLots = (value) => {
    if (value === null || value === undefined || isNaN(value)) return '0.0';
    return parseFloat(value).toFixed(1);
};

// Format percentage (2 decimals)
// Rule: zero percentages display as '-' (consistent with formatAmount)
const formatPercent = (value) => {
    if (value === null || value === undefined || isNaN(value) || value === 0) return '-';
    
    if (value < 0) {
        return '(' + Math.abs(value).toFixed(2) + '%)';
    }
    return value.toFixed(2) + '%';
};

// Get CSS class for positive/negative values
const getAmountClass = (value) => {
    if (value === null || value === undefined || isNaN(value)) return '';
    return value < 0 ? 'negative' : 'positive';
};

// Format date to DD-MMM-YY (e.g., 09-Feb-26)
const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = String(date.getDate()).padStart(2, '0');
    const month = months[date.getMonth()];
    const year = String(date.getFullYear()).slice(-2);
    return `${day}-${month}-${year}`;
};

// Debounce function for search/filter inputs
const debounce = (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

// Fetch with timeout (default 15s) — prevents app from hanging on network issues
function fetchWithTimeout(url, options, timeoutMs) {
    if (!timeoutMs) timeoutMs = 15000;
    return Promise.race([
        fetch(url, options),
        new Promise(function(_, reject) {
            setTimeout(function() { reject(new Error('Request timed out after ' + (timeoutMs / 1000) + 's')); }, timeoutMs);
        })
    ]);
}

// Show loading indicator with optional message (blocks UI — full-screen overlay)
const showLoading = (show, messageOrContainerId) => {
    // Legacy support: if second arg looks like an element ID, use it as container
    var containerId = 'loading-indicator';
    var message = null;
    if (messageOrContainerId && document.getElementById(messageOrContainerId)) {
        containerId = messageOrContainerId;
    } else if (typeof messageOrContainerId === 'string') {
        message = messageOrContainerId;
    }
    var loader = document.getElementById(containerId);
    if (loader) {
        loader.style.display = show ? 'flex' : 'none';
        // Update message text if provided
        var msgEl = loader.querySelector('p');
        if (msgEl) {
            msgEl.textContent = message || 'Loading...';
        }
    }
};

// Show alert/notification
const showAlert = (message, type = 'info', duration = 3000) => {
    const alertContainer = document.getElementById('alert-container');
    if (!alertContainer) return;
    
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.textContent = message;
    
    alertContainer.appendChild(alert);
    
    if (duration > 0) {
        setTimeout(() => {
            alert.style.opacity = '0';
            setTimeout(() => alert.remove(), 300);
        }, duration);
    }
};

// Export functions for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatPrice,
        formatAmount,
        formatQuantity,
        formatLots,
        formatPercent,
        getAmountClass,
        getUnitLabel,
        getUnitDescription,
        formatDate,
        debounce,
        showLoading,
        showAlert
    };
}
