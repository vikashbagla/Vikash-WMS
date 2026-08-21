// ============================================================================
// WMS UTILITIES - Number Formatting & Helpers
// ============================================================================

// ---------------------------------------------------------------------------
// GLOBAL "show full amount" override (F2). When ON, every DISPLAY formatter
// below shows full rupees regardless of the user's display-unit preference.
// Persistent per browser (owner request 2026-08-21). This SUPERSEDES the old
// accounting-only flag (localStorage 'wms_acct_full_amount') — migrated below.
// NOTE: getDisplayUnit() itself is deliberately NOT overridden, so anything
// that reads the unit for non-display reasons (exports, etc.) keeps the real
// unit. Only the display formatters consult getEffectiveUnitConfig().
// ---------------------------------------------------------------------------
var WMS_FULL_AMOUNT_KEY = 'wms_full_amount';
var _wmsFullAmount = false;
try {
    var _wmsFA = localStorage.getItem(WMS_FULL_AMOUNT_KEY);
    if (_wmsFA === null) _wmsFA = localStorage.getItem('wms_acct_full_amount'); // one-time carry-over
    _wmsFullAmount = (_wmsFA === '1');
} catch (e) {}
function wmsIsFullAmount() { return _wmsFullAmount; }
function wmsSetFullAmount(v) {
    _wmsFullAmount = !!v;
    try { localStorage.setItem(WMS_FULL_AMOUNT_KEY, _wmsFullAmount ? '1' : '0'); } catch (e) {}
}

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

// Effective unit config used by ALL display formatters. When the global
// full-amount override is ON, amounts are shown in full rupees (divisor 1,
// no suffix, Indian commas); otherwise the user's real display unit applies.
function getEffectiveUnitConfig() {
    if (_wmsFullAmount) return { divisor: 1, suffix: '', comma: 'indian' };
    return getUnitConfig(getDisplayUnit());
}

// Description text for a specific unit (used for titles + the "switch back to"
// label on the full-amount toggle button, which must always name the REAL unit).
function getUnitDescriptionFor(unit) {
    const descriptions = {
        'thousands': "₹ '000",
        'lakhs':     '₹ Lakhs',
        'millions':  '₹ Millions',
        'crores':    '₹ Crores'
    };
    return descriptions[unit] || '₹ Lakhs';
}

// The real (non-overridden) unit description — for the toggle button's
// "Show in <real unit>" label even while full-amount mode is active.
function getRealUnitDescription() { return getUnitDescriptionFor(getDisplayUnit()); }

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

// Format price (NO ₹ SYMBOL)
// Rule: #,##0.00 (+ve); (#,##0.00) (-ve, in red via CSS); '-' (zero)
// applyUnit=true divides by display unit; applyUnit=false shows raw price
const formatPrice = (value, applyUnit = false) => {
    if (value === null || value === undefined || isNaN(value) || value === 0) return '-';

    const config = getEffectiveUnitConfig();

    if (applyUnit) {
        // For values (apply display unit)
        const convertedValue = Math.abs(value) / config.divisor;
        const formatted = formatWithCommas(convertedValue, config.comma);
        return value < 0 ? '(' + formatted + ')' : formatted;
    } else {
        // For actual prices (always in rupees, no conversion, same comma style)
        const formatted = formatWithCommas(Math.abs(value), config.comma);
        return value < 0 ? '(' + formatted + ')' : formatted;
    }
};

// Core amount formatter (returns plain string, no HTML)
// Used by fmtNoDec and formatAmount
var formatAmountRaw = function(value) {
    if (value === null || value === undefined || isNaN(value) || value === 0) return '-';
    var config = getEffectiveUnitConfig();
    var convertedValue = Math.abs(value) / config.divisor;
    if (value < 0) return '(' + formatWithCommas(convertedValue, config.comma) + ')';
    return formatWithCommas(convertedValue, config.comma);
};

// Format amount with display unit, negative handling, and full-amount tooltip
// Rule: zero amounts display as '-' (immediate visual indicator of no value)
// Returns HTML <span> with title showing unscaled ₹ amount on hover
const formatAmount = (value) => {
    var display = formatAmountRaw(value);
    if (display === '-') return '-';
    var absVal = Math.abs(value);
    var full = absVal.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (value < 0) full = '(' + full + ')';
    return '<span title="\u20B9 ' + full + '">' + display + '</span>';
};

// Get unit label for column headers
const getUnitLabel = () => {
    // Honours the full-amount override → blank suffix (columns read "AMOUNT",
    // not "AMOUNT ('000)"), otherwise the real unit's suffix.
    return getEffectiveUnitConfig().suffix;
};

// Get full description for the portfolio title e.g. "₹ '000" or "₹ Lakhs"
const getUnitDescription = () => {
    if (_wmsFullAmount) return '₹ (full)';
    return getUnitDescriptionFor(getDisplayUnit());
};

// Format quantity (0 decimals)
// Rule: zero quantities display as '-' (consistent with formatAmount)
const formatQuantity = (value) => {
    if (value === null || value === undefined || isNaN(value) || value === 0) return '-';
    return Math.round(value).toLocaleString('en-US');
};

// Format lots (1 decimal)
// Rule: zero lots display as '-' (consistent with all formatters)
const formatLots = (value) => {
    if (value === null || value === undefined || isNaN(value) || value === 0) return '-';
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

// Get CSS class for positive/negative values (no class for zero — stays neutral)
const getAmountClass = (value) => {
    if (value === null || value === undefined || isNaN(value) || value === 0) return '';
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

// 52-week price slider (shared across Portfolio & Reports)
// current = current price, low/high = 52-week bounds, lo/hi = formatted label strings
function buildSlider(current, low, high, lo, hi) {
    if (!low || !high || high <= low) return '';
    var pct      = Math.min(100, Math.max(0, ((current - low) / (high - low)) * 100));
    var dotColor = pct >= 50 ? '#059669' : '#dc2626';
    return '<div class="price-slider">' +
               '<div class="price-slider-track">' +
                   '<div class="price-slider-dot" style="left:' + pct.toFixed(1) + '%;background:' + dotColor + ';"></div>' +
               '</div>' +
               '<div class="slider-tooltip">' +
                   '<span>' + lo + '</span>' +
                   '<span>' + hi + '</span>' +
               '</div>' +
           '</div>';
}

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
