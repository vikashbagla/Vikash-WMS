// ============================================================================
// Automated Trading Module — controllers
// ============================================================================
//
// V1 scope: Admin sub-tab only.
//   • Trigger eod-prices-ingest Edge Function (5-day smoke test or 252-day backfill)
//   • Show last run summary from auto_runs (strategy_name='_eod_ingest')
//   • market_prices snapshot (count, date range, distinct securities)
//   • auto_strategies list
//
// Open Trades / Recent Events / Run History tabs are stubs — populated in Phase 6
// after the automation-runner Edge Function lands.

'use strict';

// ----------------------------------------------------------------------------
// Tab switching
// ----------------------------------------------------------------------------

function autoSwitchTab(tabId) {
    document.querySelectorAll('.automation-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.automation-tab-panel').forEach(p => p.classList.remove('active'));
    var btn = document.querySelector('.automation-tab-btn[data-tab="' + tabId + '"]');
    var panel = document.getElementById(tabId);
    if (btn) btn.classList.add('active');
    if (panel) panel.classList.add('active');
}

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------

async function initAutomation() {
    // Wire tab buttons
    document.querySelectorAll('.automation-tab-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { autoSwitchTab(btn.dataset.tab); });
    });

    // Load admin-tab data in parallel
    autoLoadEodLastRun();
    autoLoadMarketPricesStats();
    autoLoadStrategies();
}

// Expose for app.html loader
window.initAutomation = initAutomation;

// ----------------------------------------------------------------------------
// EOD Ingest — invoke Edge Function + render response
// ----------------------------------------------------------------------------

var _autoEodInFlight = false;

async function autoRunEodIngest(daysBack, confirmFirst) {
    if (_autoEodInFlight) return;
    if (confirmFirst && !confirm('Backfill ' + daysBack + ' days for the entire universe — takes ~30s. Continue?')) return;

    _autoEodInFlight = true;
    autoSetEodStatus('loading', 'running ' + daysBack + 'd');
    autoSetEodButtonsDisabled(true);

    var responsePanel = document.getElementById('au-eod-response');
    responsePanel.style.display = 'block';
    responsePanel.innerHTML = '<div class="au-meta">⏳ Running ' + daysBack + '-day ingest… (may take ' + (daysBack > 30 ? '20–60' : '5–15') + ' seconds)</div>';

    var startedAt = Date.now();
    try {
        var resp = await fetch(SUPABASE_URL + '/functions/v1/eod-prices-ingest', {
            method: 'POST',
            headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ days_back: daysBack })
        });
        var text = await resp.text();
        var data;
        try { data = JSON.parse(text); } catch (_e) { data = { raw_response: text }; }

        var ms = Date.now() - startedAt;
        if (resp.ok && data && data.success) {
            autoSetEodStatus('success', 'success');
            autoRenderEodSuccess(data, ms);
        } else {
            autoSetEodStatus('error', 'failed');
            autoRenderEodError(data, resp.status, ms);
        }
    } catch (err) {
        autoSetEodStatus('error', 'failed');
        autoRenderEodError({ error: String(err) }, 0, Date.now() - startedAt);
    } finally {
        _autoEodInFlight = false;
        autoSetEodButtonsDisabled(false);
        // Refresh last-run + market_prices stats — they should now show today's run
        autoLoadEodLastRun();
        autoLoadMarketPricesStats();
    }
}

function autoSetEodStatus(cls, label) {
    var el = document.getElementById('au-eod-status');
    if (!el) return;
    el.className = 'au-badge ' + cls;
    el.textContent = label;
}

function autoSetEodButtonsDisabled(disabled) {
    document.querySelectorAll('#au-admin .au-btn').forEach(function (b) {
        b.disabled = disabled;
    });
}

function autoRenderEodSuccess(d, ms) {
    var rp = document.getElementById('au-eod-response');
    var html = '';
    html += '<div style="font-size:13px;color:#047857;font-weight:600">✓ Success <span class="au-badge success">' + (ms / 1000).toFixed(1) + 's</span></div>';
    html += '<div class="au-stat-grid">';
    html += autoStatBlock('Rows upserted', d.rows_upserted || 0);
    html += autoStatBlock('Resolved',      d.resolved      || 0);
    html += autoStatBlock('Missing',       (d.missing || []).length);
    html += autoStatBlock('Failed',        (d.failed_symbols || []).length);
    html += autoStatBlock('Range from',    d.range_from || '—', true);
    html += autoStatBlock('Range to',      d.range_to   || '—', true);
    html += '</div>';

    if ((d.missing || []).length > 0) {
        html += '<div class="au-warn-list"><strong>Missing from securities_db (' + d.missing.length + '):</strong> ' + d.missing.join(', ') + '</div>';
    }
    if ((d.failed_symbols || []).length > 0) {
        html += '<div class="au-error-list"><strong>Fyers errors (' + d.failed_symbols.length + '):</strong><ul>';
        d.failed_symbols.forEach(function (f) {
            html += '<li><code>' + autoEsc(f.symbol) + '</code>: ' + autoEsc(f.error) + '</li>';
        });
        html += '</ul></div>';
    }
    html += '<details style="margin-top:10px"><summary>Full JSON response</summary>';
    html += '<pre class="au-result-block">' + autoEsc(JSON.stringify(d, null, 2)) + '</pre></details>';

    rp.innerHTML = html;
}

function autoRenderEodError(d, status, ms) {
    var rp = document.getElementById('au-eod-response');
    var html = '';
    html += '<div style="font-size:13px;color:#dc2626;font-weight:600">✗ Failed' + (status ? ' (HTTP ' + status + ')' : '') + ' <span class="au-badge error">' + (ms / 1000).toFixed(1) + 's</span></div>';
    if (d && d.error) html += '<div style="margin-top:6px;color:#7f1d1d;font-size:13px">' + autoEsc(d.error) + '</div>';
    html += '<details style="margin-top:10px" open><summary>Full JSON response</summary>';
    html += '<pre class="au-result-block">' + autoEsc(JSON.stringify(d, null, 2)) + '</pre></details>';
    rp.innerHTML = html;
}

function autoStatBlock(label, value, small) {
    return '<div class="au-stat"><div class="au-stat-label">' + autoEsc(label) + '</div>' +
           '<div class="au-stat-value' + (small ? ' small' : '') + '">' + autoEsc(String(value)) + '</div></div>';
}

function autoEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
}

// ----------------------------------------------------------------------------
// Last EOD-ingest run summary — read auto_runs WHERE strategy_name='_eod_ingest'
// ----------------------------------------------------------------------------

async function autoLoadEodLastRun() {
    var el = document.getElementById('au-eod-last-run');
    if (!el) return;
    el.textContent = 'Loading last run…';
    try {
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_runs?strategy_name=eq._eod_ingest&order=started_at.desc&limit=1',
            { headers: wmsHeaders() }
        );
        var rows = await resp.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<em style="color:#9ca3af">No runs yet — try the smoke-test button above.</em>';
            autoSetEodStatus('idle', 'never run');
            return;
        }
        var r = rows[0];
        var dt = new Date(r.started_at);
        var when = dt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        var dur = r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + 's' : '—';
        var meta = r.metadata || {};

        var statusBadge = r.status === 'SUCCESS' ? '<span class="au-badge success">success</span>' :
                          r.status === 'FAILED'  ? '<span class="au-badge error">failed</span>' :
                                                   '<span class="au-badge loading">running</span>';

        el.innerHTML =
            '<span><strong>Last run:</strong> ' + when + ' ' + statusBadge + '</span>' +
            '<span><strong>Duration:</strong> ' + dur + '</span>' +
            '<span><strong>Rows:</strong> ' + (meta.rows_upserted != null ? meta.rows_upserted : '—') + '</span>' +
            '<span><strong>Resolved:</strong> ' + (meta.resolved != null ? meta.resolved : '—') + '/' + (meta.universe_size != null ? meta.universe_size : '—') + '</span>' +
            '<span><strong>Range:</strong> ' + (meta.range_from || '—') + ' → ' + (meta.range_to || '—') + '</span>';

        if (r.status === 'FAILED' && r.error) {
            el.innerHTML += '<div class="au-error-list" style="width:100%"><strong>Error:</strong> ' + autoEsc(r.error) + '</div>';
        }
        autoSetEodStatus(r.status === 'SUCCESS' ? 'success' : r.status === 'FAILED' ? 'error' : 'idle',
                         r.status.toLowerCase());
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load run history: ' + autoEsc(String(e)) + '</span>';
    }
}

// ----------------------------------------------------------------------------
// market_prices snapshot
// ----------------------------------------------------------------------------

async function autoLoadMarketPricesStats() {
    var el = document.getElementById('au-mp-stats');
    if (!el) return;
    el.textContent = 'Loading…';
    try {
        // PostgREST count via Prefer: count=exact + range header
        var countResp = await fetch(
            SUPABASE_URL + '/rest/v1/market_prices?select=id',
            { headers: wmsHeaders({ 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' }) }
        );
        var contentRange = countResp.headers.get('content-range') || '';
        var totalRows = (contentRange.split('/')[1] || '0').replace(/\D/g, '') || '0';

        // Distinct security count + min/max date — separate small queries for clarity
        var minResp = await fetch(SUPABASE_URL + '/rest/v1/market_prices?select=price_date&order=price_date.asc&limit=1',
                                  { headers: wmsHeaders() });
        var minRows = await minResp.json();
        var maxResp = await fetch(SUPABASE_URL + '/rest/v1/market_prices?select=price_date&order=price_date.desc&limit=1',
                                  { headers: wmsHeaders() });
        var maxRows = await maxResp.json();

        var minDate = minRows[0] ? minRows[0].price_date : '—';
        var maxDate = maxRows[0] ? maxRows[0].price_date : '—';

        el.innerHTML =
            '<span><strong>Total rows:</strong> ' + Number(totalRows).toLocaleString() + '</span>' +
            '<span><strong>Earliest date:</strong> ' + minDate + '</span>' +
            '<span><strong>Latest date:</strong> ' + maxDate + '</span>';
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
    }
}

// ----------------------------------------------------------------------------
// auto_strategies list
// ----------------------------------------------------------------------------

async function autoLoadStrategies() {
    var el = document.getElementById('au-strategies-list');
    if (!el) return;
    el.textContent = 'Loading…';
    try {
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_strategies?select=name,display_name,version,owner,enabled,execution_mode&order=name',
            { headers: wmsHeaders() }
        );
        var rows = await resp.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<em style="color:#9ca3af">No strategies registered yet.</em>';
            return;
        }
        var html = '<div style="width:100%"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Name</th><th style="padding:6px 8px">Display</th>' +
                '<th style="padding:6px 8px">Version</th><th style="padding:6px 8px">Owner</th>' +
                '<th style="padding:6px 8px">Enabled</th><th style="padding:6px 8px">Mode</th></tr></thead><tbody>';
        rows.forEach(function (r) {
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(r.name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoEsc(r.display_name) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(r.version || '—') + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(r.owner) + '</td>' +
                    '<td style="padding:6px 8px">' + (r.enabled ? '<span class="au-badge success">yes</span>' : '<span class="au-badge idle">no</span>') + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(r.execution_mode) + '</td></tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
    }
}
