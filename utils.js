// ============================================================================
// WMS UTILITIES - Number Formatting & Helpers
// ============================================================================

// Get user's display unit preference
function getDisplayUnit() {
    if (typeof currentUser !== 'undefined' && currentUser && currentUser.preferences) {
        return currentUser.preferences.display_unit || 'lakhs';
    }
    return 'lakhs'; // Default
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

// Format price with display unit
const formatPrice = (value) => {
    if (value === null || value === undefined || isNaN(value)) return '₹0.00';
    
    const unit = getDisplayUnit();
    const config = getUnitConfig(unit);
    const convertedValue = value / config.divisor;
    
    return '₹' + formatWithCommas(convertedValue, config.comma);
};

// Format amount with display unit and negative handling
const formatAmount = (value) => {
    if (value === null || value === undefined || isNaN(value)) return '₹0.00';
    
    const unit = getDisplayUnit();
    const config = getUnitConfig(unit);
    const convertedValue = Math.abs(value) / config.divisor;
    
    if (value < 0) {
        return '(₹' + formatWithCommas(convertedValue, config.comma) + ')';
    }
    return '₹' + formatWithCommas(convertedValue, config.comma);
};

// Get unit label for column headers
const getUnitLabel = () => {
    const unit = getDisplayUnit();
    const config = getUnitConfig(unit);
    return config.suffix;
};

// Format quantity (0 decimals)
const formatQuantity = (value) => {
    if (value === null || value === undefined || isNaN(value)) return '0';
    return Math.round(value).toLocaleString('en-IN');
};

// Format lots (1 decimal)
const formatLots = (value) => {
    if (value === null || value === undefined || isNaN(value)) return '0.0';
    return parseFloat(value).toFixed(1);
};

// Format percentage (2 decimals)
const formatPercent = (value) => {
    if (value === null || value === undefined || isNaN(value)) return '0.00%';
    
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

// Show loading indicator
const showLoading = (show, containerId = 'loading-indicator') => {
    const loader = document.getElementById(containerId);
    if (loader) {
        loader.style.display = show ? 'flex' : 'none';
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
        formatDate,
        debounce,
        showLoading,
        showAlert
    };
}
