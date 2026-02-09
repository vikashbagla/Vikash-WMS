// ============================================================================
// WMS UTILITIES - Number Formatting & Helpers
// ============================================================================

// Indian number formatting (lakhs/crores system)
const formatIndianNumber = (num) => {
    if (num === null || num === undefined || isNaN(num)) return '0';
    
    const numStr = Math.abs(num).toFixed(2);
    const [integer, decimal] = numStr.split('.');
    
    // Indian numbering: ##,##,###
    let lastThree = integer.substring(integer.length - 3);
    const otherNumbers = integer.substring(0, integer.length - 3);
    
    if (otherNumbers !== '') {
        lastThree = ',' + lastThree;
    }
    
    const result = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + lastThree;
    
    return decimal ? result + '.' + decimal : result;
};

// Format price (2 decimals)
const formatPrice = (value) => {
    if (value === null || value === undefined || isNaN(value)) return '₹0.00';
    return '₹' + formatIndianNumber(value);
};

// Format amount with negative handling
const formatAmount = (value) => {
    if (value === null || value === undefined || isNaN(value)) return '₹0.00';
    
    if (value < 0) {
        return '(₹' + formatIndianNumber(Math.abs(value)) + ')';
    }
    return '₹' + formatIndianNumber(value);
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
        formatDate,
        debounce,
        showLoading,
        showAlert
    };
}
