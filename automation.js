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

    // Lazy-load on first activation of dashboard tabs
    if (tabId === 'au-open-trades' && !window._auOpenTradesLoaded) { autoLoadGsOpenTrades(); autoLoadGsClosedTrades(); autoLoadOpenTrades(); autoLoadClosedTrades(); window._auOpenTradesLoaded = true; }
    if (tabId === 'au-events'      && !window._auEventsLoaded)     { autoLoadEvents('all');  window._auEventsLoaded = true; }
    if (tabId === 'au-runs'        && !window._auRunsLoaded)       { autoLoadRuns('all');    window._auRunsLoaded = true; }
    if (tabId === 'au-live'        && !window._auLiveLoaded)       { autoLoadLive();         window._auLiveLoaded = true; }

    // Open Trades P&L refreshes via the shared app-wide price timer (no module
    // timer). Ensure the provider is registered + the single timer is running.
    if (tabId === 'au-open-trades') {
        autoEnsureSharedRefresh();
    }

    // Refresh the fixed bar's visibility — it floats above every tab so we must
    // suppress it explicitly when leaving Open Trades.
    autoUpdateGsTotalsBar();
}

// ----------------------------------------------------------------------------
// Family tab switching (Phase A of UI reimagining, 2026-07-09)
//
// Strategy-family-first workspace: [Health] [GS] [KH] [Pairs] [Legacy view].
// Legacy panel wraps the existing sub-tabs unchanged. Family pages ship in
// Phases B–D. See Documentation/automation/UI-REIMAGINE-PLAN.md.
// ----------------------------------------------------------------------------

function autoSwitchFamily(fam) {
    if (!fam) return;
    document.querySelectorAll('.au-fam-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.automation-family-panel').forEach(p => p.classList.remove('active'));
    var btn = document.querySelector('.au-fam-tab-btn[data-fam="' + fam + '"]');
    var panel = document.getElementById('au-fam-' + fam);
    if (btn) btn.classList.add('active');
    if (panel) panel.classList.add('active');

    if (fam === 'health') {
        if (!window._auHpMirrorsReady) autoHealthSetupPlatformMirrors();
        if (!window._auHealthLoaded) {
            autoHealthLoadAll();
            window._auHealthLoaded = true;
        }
    }

    if (fam === 'pairs') {
        if (!window._auPairsFamMirrorReady) autoPairsFamSetupMirror();
        if (!window._auPairsFamLoaded) {
            autoLoadPairsFamRefresh();
            window._auPairsFamLoaded = true;
        }
        autoEnsureSharedRefresh();
    }

    if (fam === 'kh') {
        if (!window._auKhFamMirrorReady) autoKhFamSetupMirror();
        if (!window._auKhFamLoaded) {
            autoLoadKhFamRefresh();
            window._auKhFamLoaded = true;
        } else {
            autoRenderKhFamMetrics();
        }
    }

    if (fam === 'gs') {
        // First-time init: set up DOM mirroring so any legacy Open/Closed render
        // also fills the family page targets, plus trigger initial load.
        if (!window._auGsFamMirrorReady) autoGsFamSetupMirror();
        if (!window._auGsFamLoaded) {
            autoLoadGsFamRefresh();
            window._auGsFamLoaded = true;
        } else {
            // Refresh metrics from the last-known _auGsTotals in case they've drifted.
            autoRenderGsFamMetrics();
        }
        // GS Open Trades live P&L uses the shared refresh timer; make sure it's armed.
        autoEnsureSharedRefresh();
    }

    // GS totals bar hides itself when the GS Open Trades sub-tab isn't visible;
    // toggling family visibility must retrigger that check.
    autoUpdateGsTotalsBar();
}

// ----------------------------------------------------------------------------
// Shared source-filter state — kept in a single variable so the Legacy dropdown
// (Legacy → Open Trades → GS card) and the family-page dropdown (GS → Closed
// Trades tab) always agree. Changing either one syncs the other and re-runs
// autoLoadGsClosedTrades. Read from autoLoadGsClosedTrades via _srcFilter.
// ----------------------------------------------------------------------------
var _auGsClosedSourceFilter = 'all';

function autoGsSetClosedSourceFilter(value) {
    _auGsClosedSourceFilter = value || 'all';
    // Mirror the value to whichever dropdowns exist right now.
    ['au-gs-closed-source-filter', 'au-gs-fam-closed-source-filter'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.value !== _auGsClosedSourceFilter) el.value = _auGsClosedSourceFilter;
    });
    // Peak recomputes inside autoLoadGsClosedTrades. Re-run + re-render metrics.
    if (typeof autoLoadGsClosedTrades === 'function') autoLoadGsClosedTrades();
}

// ----------------------------------------------------------------------------
// GS family page (Phase B — 2026-07-09)
//
// The Open Trades + Closed Trades tables are shared with Legacy via DOM
// mirroring. autoLoadGsOpenTrades / autoLoadGsClosedTrades render into
// au-gs-open-content / au-gs-closed-content; a MutationObserver copies the
// output into au-gs-fam-open-content / au-gs-fam-closed-content so both
// views stay in perfect sync without duplicating render logic.
// (Signals / Runs / Controls / Admin ship in Phase B.2 / B.3.)
// ----------------------------------------------------------------------------

function autoGsFamSetupMirror() {
    var pairs = [
        ['au-gs-open-content',   'au-gs-fam-open-content'],
        ['au-gs-closed-content', 'au-gs-fam-closed-content']
    ];
    pairs.forEach(function (p) {
        var src = document.getElementById(p[0]);
        var dst = document.getElementById(p[1]);
        if (!src || !dst || src._auMirrored) return;
        src._auMirrored = true;
        // Initial snapshot
        dst.innerHTML = src.innerHTML;
        // Live mirror on subsequent renders (innerHTML sets fire childList mutations)
        new MutationObserver(function () {
            dst.innerHTML = src.innerHTML;
            // Metrics live off _auGsTotals which the load functions populate; recompute UI.
            autoRenderGsFamMetrics();
        }).observe(src, { childList: true, subtree: true, characterData: true });
    });
    // Also mirror the status badges (Open / Closed count pills next to sub-tab labels).
    var badges = [
        ['au-gs-open-status',   'au-gs-fam-open-badge'],
        ['au-gs-closed-status', 'au-gs-fam-closed-badge']
    ];
    badges.forEach(function (p) {
        var src = document.getElementById(p[0]);
        var dst = document.getElementById(p[1]);
        if (!src || !dst || src._auBadgeMirrored) return;
        src._auBadgeMirrored = true;
        dst.className = src.className;
        dst.textContent = src.textContent;
        new MutationObserver(function () {
            dst.className = src.className;
            dst.textContent = src.textContent;
        }).observe(src, { childList: true, subtree: true, characterData: true, attributes: true });
    });
    // Initialize both source-filter dropdowns to the shared state value so a
    // filter set on Legacy earlier in the session persists onto the family page
    // (and vice-versa).
    ['au-gs-closed-source-filter', 'au-gs-fam-closed-source-filter'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.value !== _auGsClosedSourceFilter) el.value = _auGsClosedSourceFilter;
    });
    window._auGsFamMirrorReady = true;
}

function autoLoadGsFamRefresh() {
    // Delegate to the existing loaders — mirroring pulls the output into the family page.
    if (typeof autoLoadGsOpenTrades === 'function') autoLoadGsOpenTrades();
    if (typeof autoLoadGsClosedTrades === 'function') autoLoadGsClosedTrades();
    // Header metadata + Phase B.2 tabs
    autoLoadGsFamHeader();
    autoLoadGsFamEvents();
    autoLoadGsFamRuns();
    autoLoadGsFamAdmin();
}

// ----------------------------------------------------------------------------
// GS Signals & Events tab (Phase B.2) — auto_signals scoped to GS strategies
// ----------------------------------------------------------------------------
var _AU_GS_STRATS = ['silver_mini_15m', 'gold_mini_15m'];

async function autoLoadGsFamEvents(filterOverride) {
    var el = document.getElementById('au-gs-fam-events-content');
    var statusEl = document.getElementById('au-gs-fam-events-status');
    if (!el) return;
    var typeSel = document.getElementById('au-gs-fam-events-filter');
    var stratSel = document.getElementById('au-gs-fam-events-strat');
    var typeFilter = filterOverride && typeof filterOverride === 'string' && filterOverride !== '[object Event]'
        ? filterOverride
        : (typeSel ? typeSel.value : 'all');
    if (typeSel && typeFilter !== typeSel.value) typeSel.value = typeFilter;
    var stratFilter = stratSel ? stratSel.value : 'all';

    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }

    var strats = stratFilter === 'all' ? _AU_GS_STRATS : [stratFilter];
    var qs = '?strategy_name=in.(' + strats.join(',') + ')' +
             '&order=fired_at.desc&limit=200' +
             '&select=id,trade_id,strategy_name,fired_at,event_type,direction,legs,metadata,source,email_status';
    if (typeFilter === 'ENTRY')      qs += '&event_type=eq.ENTRY';
    else if (typeFilter === 'EXIT')  qs += '&event_type=neq.ENTRY';

    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_signals' + qs, { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No events match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 events'; }
            return;
        }

        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px;white-space:nowrap">Time (IST)</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Event</th>' +
                '<th style="padding:6px 8px">Side</th>' +
                '<th style="padding:6px 8px">Contract</th>' +
                '<th style="padding:6px 8px;text-align:right">Qty</th>' +
                '<th style="padding:6px 8px;text-align:right">Price</th>' +
                '<th style="padding:6px 8px">Source</th>' +
                '<th style="padding:6px 8px">Version</th>' +
                '<th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px">Trade</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (s) {
            var m = s.metadata || {};
            var leg = (s.legs && s.legs[0]) || {};
            var typeColor = s.event_type === 'ENTRY' ? '#047857' :
                           /^EXIT_SL|STOP_HIT/.test(s.event_type) ? '#dc2626' :
                           /^EXIT/.test(s.event_type) ? '#0891b2' :
                           s.event_type === 'MANUAL_CLOSE' ? '#92400e' : '#6b7280';
            var side = s.direction || (leg.side === 'BUY' ? 'LONG' : leg.side === 'SELL' ? 'SHORT' : '—');
            var contract = leg.symbol ? autoFmtContract(leg.symbol, leg.expiry_date) : '—';
            var qty = m.qty_lots != null ? m.qty_lots + ' lot' + (m.qty_lots == 1 ? '' : 's') : (leg.qty || '—');
            var price = leg.price != null ? autoFmtPrice0(Number(leg.price)) : '—';
            var srcBadge = s.source === 'chassis' ? '<span class="au-badge success" style="font-size:9px">runner</span>'
                        : s.source === 'tv_webhook' ? '<span class="au-badge idle" style="font-size:9px">TV webhook</span>'
                        : '<span style="color:#9ca3af">' + autoEsc(s.source || '—') + '</span>';
            var ver = (m.strategy_version || m.version || '—');
            var emailBadge = s.email_status === 'SENT' ? '<span class="au-badge success" style="font-size:9px">sent</span>'
                          : s.email_status === 'FAILED' ? '<span class="au-badge error" style="font-size:9px">failed</span>'
                          : s.email_status === 'PENDING' ? '<span class="au-badge loading" style="font-size:9px">pending</span>'
                          : '<span class="au-badge idle" style="font-size:9px">—</span>';
            var tradeFrag = s.trade_id ? s.trade_id.slice(0, 20) : '—';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(s.fired_at)) + '</td>' +
                    '<td style="padding:6px 8px"><code style="font-size:11px">' + autoEsc(s.strategy_name.replace('_mini_15m', '')) + '</code></td>' +
                    '<td style="padding:6px 8px;color:' + typeColor + ';font-weight:600">' + autoEsc(s.event_type) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(side) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(contract) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + autoEsc(String(qty)) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">' + price + '</td>' +
                    '<td style="padding:6px 8px">' + srcBadge + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:10px;color:#6b7280">' + autoEsc(ver) + '</td>' +
                    '<td style="padding:6px 8px">' + emailBadge + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:10px;color:#6b7280" title="' + autoEsc(s.trade_id || '') + '">' + autoEsc(tradeFrag) + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' events'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----------------------------------------------------------------------------
// GS Run History tab (Phase B.2) — auto_runs scoped to GS strategies
// ----------------------------------------------------------------------------
async function autoLoadGsFamRuns(filterOverride) {
    var el = document.getElementById('au-gs-fam-runs-content');
    var statusEl = document.getElementById('au-gs-fam-runs-status');
    if (!el) return;
    var sel = document.getElementById('au-gs-fam-runs-filter');
    var filter = filterOverride && typeof filterOverride === 'string' && filterOverride !== '[object Event]'
        ? filterOverride
        : (sel ? sel.value : 'all');
    if (sel && filter !== sel.value) sel.value = filter;

    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }

    var qs = '?strategy_name=in.(' + _AU_GS_STRATS.join(',') + ')' +
             '&order=started_at.desc&limit=100' +
             '&select=id,strategy_name,started_at,finished_at,duration_ms,status,signals_generated,emails_sent,emails_failed,error';
    if (filter === 'failed')            qs += '&status=eq.FAILED';
    else if (filter === 'with_signals') qs += '&signals_generated=gt.0';

    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_runs' + qs, { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No runs match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 runs'; }
            return;
        }
        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px">Started (IST)</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px;text-align:right">Signals</th>' +
                '<th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px;text-align:right">Duration</th>' +
                '<th style="padding:6px 8px">Error</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (rn) {
            var emailCell = '—';
            if (rn.emails_sent || rn.emails_failed) {
                var sent = rn.emails_sent || 0, failed = rn.emails_failed || 0;
                emailCell = (failed > 0 ? '<span style="color:#dc2626">' + failed + ' failed</span>' : '') +
                            (sent > 0 && failed > 0 ? ' / ' : '') +
                            (sent > 0 ? '<span style="color:#047857">' + sent + ' sent</span>' : '');
            }
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(rn.started_at)) + '</td>' +
                    '<td style="padding:6px 8px"><code style="font-size:11px">' + autoEsc(rn.strategy_name.replace('_mini_15m', '')) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoStatusBadge(rn.status) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + (rn.signals_generated != null ? rn.signals_generated : '—') + '</td>' +
                    '<td style="padding:6px 8px;font-size:11px">' + emailCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">' + autoFmtDuration(rn.duration_ms) + '</td>' +
                    '<td style="padding:6px 8px;color:#7f1d1d;font-size:11px;max-width:400px;overflow:hidden;text-overflow:ellipsis" title="' + autoEsc(rn.error || '') + '">' +
                        autoEsc((rn.error || '').slice(0, 100)) + (rn.error && rn.error.length > 100 ? '…' : '') +
                    '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' runs'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----------------------------------------------------------------------------
// GS Controls & Admin tab (Phase B.2 — admin bits only; controls in B.3)
// Renders: strategy config, plugin version, gs_catalogue snapshot.
// ----------------------------------------------------------------------------
async function autoLoadGsFamAdmin() {
    // 1. auto_strategies rows for silver + gold
    var stratsEl = document.getElementById('au-gs-fam-strategies');
    if (stratsEl) {
        try {
            var r = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=in.(' + _AU_GS_STRATS.join(',') + ')&select=*',
                { headers: wmsHeaders() });
            var rows = r.ok ? await r.json() : [];
            if (rows.length === 0) {
                stratsEl.innerHTML = '<div class="au-soon">No matching auto_strategies rows.</div>';
            } else {
                // Cron column dropped — scheduling isn't per-strategy for GS;
                // see the Scheduling card below for the actual cron topology.
                var html = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
                html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                        '<th style="padding:6px 8px">Name</th>' +
                        '<th style="padding:6px 8px">Enabled</th>' +
                        '<th style="padding:6px 8px">Mode</th>' +
                        '<th style="padding:6px 8px">Version</th>' +
                        '<th style="padding:6px 8px">Metadata</th>' +
                        '</tr></thead><tbody>';
                rows.forEach(function (s) {
                    var meta = s.metadata ? JSON.stringify(s.metadata) : '—';
                    html += '<tr style="border-top:1px solid #e5e7eb">' +
                            '<td style="padding:6px 8px"><code>' + autoEsc(s.name) + '</code></td>' +
                            '<td style="padding:6px 8px">' + (s.enabled ? '<span class="au-badge success">yes</span>' : '<span class="au-badge error">no</span>') + '</td>' +
                            '<td style="padding:6px 8px"><b>' + autoEsc(s.execution_mode || '—') + '</b></td>' +
                            '<td style="padding:6px 8px;font-family:monospace">' + autoEsc(s.version || '—') + '</td>' +
                            '<td style="padding:6px 8px;font-family:monospace;font-size:10px;color:#6b7280;max-width:500px;overflow:hidden;text-overflow:ellipsis" title="' + autoEsc(meta) + '">' + autoEsc(meta.slice(0, 120)) + (meta.length > 120 ? '…' : '') + '</td>' +
                            '</tr>';
                });
                html += '</tbody></table>';
                stratsEl.innerHTML = html;
            }
        } catch (e) {
            stratsEl.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        }
    }

    // 2. Scheduling — external cron-job.org cron topology. auto_strategies.cron_schedule
    //    is null for GS by design (strategies don't own their cadence); reads
    //    latest auto_runs row to display "last run" freshness per cron.
    var schedEl = document.getElementById('au-gs-fam-scheduling');
    if (schedEl) {
        var schedJobs = [
            { key: 'silver_mini_15m', label: 'Silver signal scan', endpoint: 'automation-runner?strategy=silver_mini_15m', cadence: 'every 15 min · MCX hours (9:00–23:30 IST)', staleMinutes: 45 },
            { key: 'gold_mini_15m',   label: 'Gold signal scan',   endpoint: 'automation-runner?strategy=gold_mini_15m',   cadence: 'every 15 min · MCX hours (9:00–23:30 IST)', staleMinutes: 45 },
            { key: '_eod_ingest',     label: 'EOD prices ingest',  endpoint: 'eod-prices-ingest',                          cadence: 'daily · after MCX close (~23:35 IST)',      staleMinutes: 60 * 30 }
        ];
        try {
            var results = await Promise.all(schedJobs.map(function (j) {
                return fetch(SUPABASE_URL + '/rest/v1/auto_runs?strategy_name=eq.' + encodeURIComponent(j.key) + '&order=finished_at.desc&limit=1&select=finished_at,status',
                    { headers: wmsHeaders() }).then(function (r) { return r.ok ? r.json() : []; });
            }));
            var now = Date.now();
            var html = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
            html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                    '<th style="padding:6px 8px">Job</th>' +
                    '<th style="padding:6px 8px">Endpoint (Edge Function)</th>' +
                    '<th style="padding:6px 8px">Cadence</th>' +
                    '<th style="padding:6px 8px">Last run</th>' +
                    '<th style="padding:6px 8px">Status</th>' +
                    '</tr></thead><tbody>';
            schedJobs.forEach(function (j, i) {
                var row = results[i][0];
                var lastCell, badgeCell;
                if (!row || !row.finished_at) {
                    lastCell = '<span style="color:#9ca3af">never</span>';
                    badgeCell = '<span class="au-badge idle" style="font-size:10px">no data</span>';
                } else {
                    var ageMin = Math.round((now - new Date(row.finished_at).getTime()) / 60000);
                    var stale = ageMin > j.staleMinutes;
                    var ago = ageMin < 60 ? (ageMin + 'm ago') : ageMin < 1440 ? (Math.round(ageMin/60) + 'h ago') : (Math.round(ageMin/1440) + 'd ago');
                    lastCell = '<span title="' + autoEsc(autoFmtIST(row.finished_at)) + '">' + ago + '</span>';
                    var okStatus = (row.status === 'success' || row.status === 'OK' || row.status === 'ok');
                    if (stale)         badgeCell = '<span class="au-badge error" style="font-size:10px">STALE</span>';
                    else if (okStatus) badgeCell = '<span class="au-badge success" style="font-size:10px">OK</span>';
                    else               badgeCell = '<span class="au-badge idle" style="font-size:10px">' + autoEsc(row.status || '—') + '</span>';
                }
                html += '<tr style="border-top:1px solid #e5e7eb">' +
                        '<td style="padding:6px 8px"><b>' + autoEsc(j.label) + '</b></td>' +
                        '<td style="padding:6px 8px;font-family:monospace;font-size:11px;color:#4b5563">' + autoEsc(j.endpoint) + '</td>' +
                        '<td style="padding:6px 8px;font-size:11px;color:#4b5563">' + autoEsc(j.cadence) + '</td>' +
                        '<td style="padding:6px 8px;font-size:11px">' + lastCell + '</td>' +
                        '<td style="padding:6px 8px">' + badgeCell + '</td>' +
                        '</tr>';
            });
            html += '</tbody></table>';
            html += '<div style="font-size:11px;color:#6b7280;margin-top:8px;line-height:1.5">' +
                    '• Triggers configured at <a href="https://cron-job.org" target="_blank" style="color:#2563eb">cron-job.org</a> — not editable from WMS.<br>' +
                    '• Silver &amp; gold have SEPARATE cron entries (EXPLICIT_ONLY_STRATEGIES guard in the runner blocks accidental invocation).<br>' +
                    '• A stalled cron here means cron-job.org didn\'t hit the EF; check its dashboard.' +
                    '</div>';
            schedEl.innerHTML = html;
        } catch (e) {
            schedEl.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        }
    }

    // 3. Plugin version — most-recent auto_signals row's metadata.strategy_version wins
    //    (that's the source-of-truth for what's currently running). Falls back to
    //    auto_strategies.version if no recent signal.
    var vEl = document.getElementById('au-gs-fam-plugin-version');
    if (vEl) {
        try {
            var r = await fetch(SUPABASE_URL + '/rest/v1/auto_signals?strategy_name=in.(' + _AU_GS_STRATS.join(',') + ')&source=eq.chassis&order=fired_at.desc&limit=1&select=metadata,fired_at',
                { headers: wmsHeaders() });
            var rows = r.ok ? await r.json() : [];
            var version = null, since = null;
            if (rows[0] && rows[0].metadata) {
                version = rows[0].metadata.strategy_version || rows[0].metadata.version;
                since = rows[0].fired_at;
            }
            if (version) {
                vEl.innerHTML = autoEsc(version) +
                    (since ? ' <span style="color:#6b7280;font-size:11px;font-weight:400;font-family:sans-serif"> (last observed ' + autoEsc(autoFmtIST(since)) + ')</span>' : '');
            } else {
                vEl.textContent = 'not yet observed in signals';
            }
        } catch (e) {
            vEl.innerHTML = '<span style="color:#dc2626">' + autoEsc(String(e)) + '</span>';
        }
    }

    // 4. gs_catalogue — hard-coded in the plugin, so we compute from helper fns
    var catEl = document.getElementById('au-gs-fam-catalogue');
    if (catEl && typeof autoGsPointValue === 'function') {
        var instruments = [
            { short: 'SILVERM', name: 'MCX Silver Mini', unit: '5 kg / lot' },
            { short: 'GOLDM',   name: 'MCX Gold Mini',   unit: '100 g / lot' }
        ];
        var html = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Instrument</th>' +
                '<th style="padding:6px 8px">Lot size</th>' +
                '<th style="padding:6px 8px;text-align:right">Point value (₹/pt)</th>' +
                '<th style="padding:6px 8px;text-align:right">Margin %</th>' +
                '</tr></thead><tbody>';
        instruments.forEach(function (inst) {
            var pv = autoGsPointValue(inst.short);
            var mp = typeof autoGsMarginPct === 'function' ? autoGsMarginPct(inst.short) : null;
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><b>' + autoEsc(inst.short) + '</b> <span style="color:#6b7280">— ' + autoEsc(inst.name) + '</span></td>' +
                    '<td style="padding:6px 8px">' + autoEsc(inst.unit) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + (pv != null ? '₹' + pv : '—') + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + (mp != null ? mp + '%' : '—') + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table>';
        catEl.innerHTML = html;
    }
}

// ============================================================================
// Pairs family page (Phase C — 2026-07-09)
//
// Same anatomy as GS. Open/Closed inherit via DOM mirroring from Legacy tables
// (au-open-trades-content → au-pairs-fam-open-content, likewise for closed).
// Signals & Events / Run History / Admin have their own renderers scoped to
// non-GS strategies. Controls are locked per LESSONS §B.21.8.
// ============================================================================

function autoPairsFamSetupMirror() {
    var pairs = [
        ['au-open-trades-content',   'au-pairs-fam-open-content'],
        ['au-closed-trades-content', 'au-pairs-fam-closed-content']
    ];
    pairs.forEach(function (p) {
        var src = document.getElementById(p[0]);
        var dst = document.getElementById(p[1]);
        if (!src || !dst || src._auPairsMirrored) return;
        src._auPairsMirrored = true;
        dst.innerHTML = src.innerHTML;
        new MutationObserver(function () {
            dst.innerHTML = src.innerHTML;
            autoRenderPairsFamMetrics();
        }).observe(src, { childList: true, subtree: true, characterData: true });
    });
    var badges = [
        ['au-open-trades-status',   'au-pairs-fam-open-badge'],
        ['au-closed-trades-status', 'au-pairs-fam-closed-badge']
    ];
    badges.forEach(function (p) {
        var src = document.getElementById(p[0]);
        var dst = document.getElementById(p[1]);
        if (!src || !dst || src._auPairsBadgeMirrored) return;
        src._auPairsBadgeMirrored = true;
        dst.className = src.className;
        dst.textContent = src.textContent;
        new MutationObserver(function () {
            dst.className = src.className;
            dst.textContent = src.textContent;
        }).observe(src, { childList: true, subtree: true, characterData: true, attributes: true });
    });
    window._auPairsFamMirrorReady = true;
}

function autoLoadPairsFamRefresh() {
    if (typeof autoLoadOpenTrades === 'function')   autoLoadOpenTrades();
    if (typeof autoLoadClosedTrades === 'function') autoLoadClosedTrades();
    autoLoadPairsFamHeader();
    autoLoadPairsFamEvents();
    autoLoadPairsFamRuns();
    autoLoadPairsFamAdmin();
    autoLoadPairsFamMetricsFull();  // extra queries for metrics not covered by mirror
}

// ----- Header (mode pill + last activity) ------------------------------------
async function autoLoadPairsFamHeader() {
    try {
        // Mode: read auto_strategies for pairs strategies (non-GS)
        var webhookStrats = await autoGetWebhookStrategyNames();
        var sr = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?enabled=eq.true&select=name,execution_mode',
            { headers: wmsHeaders() });
        var all = sr.ok ? await sr.json() : [];
        var pairsStrats = all.filter(function (s) { return s.name && !s.name.startsWith('_') && !webhookStrats.has(s.name); });
        var pill = document.getElementById('au-pairs-fam-mode');
        if (pill) {
            if (pairsStrats.length === 0) { pill.className = 'status-pill stopped'; pill.textContent = '⏹ NO ENABLED PAIRS STRATEGIES'; }
            else if (pairsStrats.some(function (s) { return s.execution_mode === 'LIVE'; })) { pill.className = 'status-pill live';  pill.textContent = '🟢 LIVE'; }
            else                                                                             { pill.className = 'status-pill paper'; pill.textContent = '🟡 PAPER'; }
        }
        // Last activity — most-recent auto_signals for non-GS strategies
        var stratNames = pairsStrats.map(function (s) { return s.name; });
        if (stratNames.length > 0) {
            var ar = await fetch(SUPABASE_URL + '/rest/v1/auto_signals?strategy_name=in.(' + stratNames.join(',') + ')&order=fired_at.desc&limit=1&select=fired_at,event_type,strategy_name',
                { headers: wmsHeaders() });
            var last = ar.ok ? (await ar.json())[0] : null;
            var laEl = document.getElementById('au-pairs-fam-lastact');
            if (laEl) {
                if (last) {
                    var ago = Math.round((Date.now() - new Date(last.fired_at).getTime()) / 60000);
                    var agoStr = ago < 60 ? (ago + 'm ago') : ago < 1440 ? (Math.round(ago/60) + 'h ago') : (Math.round(ago/1440) + 'd ago');
                    laEl.textContent = 'Last activity: ' + last.event_type + ' · ' + last.strategy_name + ' · ' + agoStr;
                } else {
                    laEl.textContent = 'Last activity: no signals yet';
                }
            }
        }
    } catch (_e) { /* silent */ }
}

// ----- Metrics --------------------------------------------------------------
var _auPairsMetrics = { openCount: null, openLivePnl: null, realised: null, avgZ: null, avgZN: null, signalsIn30d: null, lastScanAt: null };

function autoRenderPairsFamMetrics() {
    var t = _auPairsMetrics;
    var fmt = function (n) { if (n == null) return '—'; return '₹' + Math.round(n).toLocaleString('en-IN'); };
    var fmtSigned = function (n) {
        if (n == null) return '—';
        var sign = n >= 0 ? '+' : '−';
        return sign + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN');
    };
    var setText = function (id, txt, cls) {
        var e = document.getElementById(id);
        if (!e) return;
        e.textContent = txt;
        if (cls !== undefined) e.className = 'metric-value ' + cls;
    };
    var setSub = function (id, txt) { var e = document.getElementById(id); if (e) e.textContent = txt || ''; };

    if (t.openCount != null) {
        setText('au-pairs-fam-metric-open', t.openCount + (t.openCount === 1 ? ' trade' : ' trades'), '');
        setSub('au-pairs-fam-metric-open-sub', t.openLivePnl != null ? ('live P&L ' + fmtSigned(t.openLivePnl)) : '');
    }
    if (t.realised != null) {
        setText('au-pairs-fam-metric-realised', fmtSigned(t.realised), t.realised >= 0 ? 'pos' : 'neg');
        setSub('au-pairs-fam-metric-realised-sub', '');
    }
    if (t.avgZ != null) {
        setText('au-pairs-fam-metric-avgz', t.avgZ.toFixed(2), '');
        setSub('au-pairs-fam-metric-avgz-sub', t.avgZN != null ? ('n=' + t.avgZN + ' entries') : '');
    }
    if (t.lastScanAt) {
        var ago = Math.round((Date.now() - new Date(t.lastScanAt).getTime()) / 60000);
        var agoStr = ago < 60 ? (ago + 'm ago') : ago < 1440 ? (Math.round(ago/60) + 'h ago') : (Math.round(ago/1440) + 'd ago');
        setText('au-pairs-fam-metric-lastscan', agoStr, '');
        setSub('au-pairs-fam-metric-lastscan-sub', new Date(t.lastScanAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
    }
    if (t.signalsIn30d != null) {
        setText('au-pairs-fam-metric-signals', String(t.signalsIn30d), '');
        setSub('au-pairs-fam-metric-signals-sub', '');
    }
}

async function autoLoadPairsFamMetricsFull() {
    try {
        var webhookStrats = await autoGetWebhookStrategyNames();

        // Open count from view (excluding GS + utility _-prefixed)
        var vr = await fetch(SUPABASE_URL + '/rest/v1/v_auto_open_trades?select=strategy_name,net_qty', { headers: wmsHeaders() });
        if (vr.ok) {
            var openRows = await vr.json();
            var pairsOpen = (openRows || []).filter(function (r) {
                return r.strategy_name && !r.strategy_name.startsWith('_') && !webhookStrats.has(r.strategy_name);
            });
            _auPairsMetrics.openCount = pairsOpen.length;
        }

        // Realised P&L all-time and 30-day signal count from auto_signals — approximate:
        // for a proper realised we'd need to walk entry/exit pairs; for now show a
        // signals-count proxy plus deep-link Legacy for full realised (until we
        // wire the same walker used by autoLoadClosedTrades to feed a state var).
        var since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        var sc = await fetch(SUPABASE_URL + '/rest/v1/auto_signals?event_type=eq.ENTRY&fired_at=gte.' + since30 + '&select=score,metadata,strategy_name',
            { headers: wmsHeaders() });
        if (sc.ok) {
            var entries = (await sc.json()).filter(function (s) {
                return s.strategy_name && !s.strategy_name.startsWith('_') && !webhookStrats.has(s.strategy_name);
            });
            _auPairsMetrics.signalsIn30d = entries.length;
            // Avg Z at entry — from metadata.Z90 field (per legacy render at line 2056)
            var zVals = entries.map(function (s) { return s.metadata && s.metadata.Z90 != null ? Math.abs(Number(s.metadata.Z90)) : null; })
                               .filter(function (v) { return v != null && !isNaN(v); });
            if (zVals.length > 0) {
                _auPairsMetrics.avgZ = zVals.reduce(function (a, b) { return a + b; }, 0) / zVals.length;
                _auPairsMetrics.avgZN = zVals.length;
            } else { _auPairsMetrics.avgZ = null; _auPairsMetrics.avgZN = null; }
        }

        // Last scan = latest auto_runs finished_at for any non-GS non-utility strategy
        var lr = await fetch(SUPABASE_URL + '/rest/v1/auto_runs?order=finished_at.desc&limit=20&select=strategy_name,finished_at',
            { headers: wmsHeaders() });
        if (lr.ok) {
            var runs = await lr.json();
            var lastPairsRun = runs.find(function (r) {
                return r.strategy_name && !r.strategy_name.startsWith('_') && !webhookStrats.has(r.strategy_name);
            });
            _auPairsMetrics.lastScanAt = lastPairsRun ? lastPairsRun.finished_at : null;
        }

        autoRenderPairsFamMetrics();
    } catch (_e) { /* silent */ }
}

// ----- Signals & Events tab -------------------------------------------------
async function autoLoadPairsFamEvents(filterOverride) {
    var el = document.getElementById('au-pairs-fam-events-content');
    var statusEl = document.getElementById('au-pairs-fam-events-status');
    if (!el) return;
    var sel = document.getElementById('au-pairs-fam-events-filter');
    var filter = filterOverride && typeof filterOverride === 'string' && filterOverride !== '[object Event]'
        ? filterOverride : (sel ? sel.value : 'all');
    if (sel && filter !== sel.value) sel.value = filter;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }

    try {
        var webhookStrats = await autoGetWebhookStrategyNames();
        // Ideally we'd filter server-side; PostgREST doesn't support "not in (...)"
        // cleanly for arbitrary sets, so overfetch + client-filter (limit 300).
        var qs = '?order=fired_at.desc&limit=300&select=id,trade_id,strategy_name,fired_at,event_type,direction,score,metadata,source,email_status';
        if (filter === 'ENTRY')     qs += '&event_type=eq.ENTRY';
        else if (filter === 'EXIT') qs += '&event_type=neq.ENTRY';
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_signals' + qs, { headers: wmsHeaders() });
        var all = r.ok ? await r.json() : [];
        var rows = (all || []).filter(function (s) {
            return s.strategy_name && !s.strategy_name.startsWith('_') && !webhookStrats.has(s.strategy_name);
        }).slice(0, 200);

        if (rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No pairs events match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 events'; }
            return;
        }

        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px">Time (IST)</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Pair</th>' +
                '<th style="padding:6px 8px">Event</th>' +
                '<th style="padding:6px 8px">Side</th>' +
                '<th style="padding:6px 8px;text-align:right">Score</th>' +
                '<th style="padding:6px 8px;text-align:right">Z90</th>' +
                '<th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px">Trade</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (s) {
            var m = s.metadata || {};
            var typeColor = s.event_type === 'ENTRY' ? '#047857' :
                           /STOP_HIT|EXIT_STOP/.test(s.event_type) ? '#dc2626' :
                           /TARGET_HIT|EXIT_TARGET/.test(s.event_type) ? '#0891b2' :
                           s.event_type === 'TIME_STOP' ? '#92400e' :
                           s.event_type === 'MANUAL_CLOSE' ? '#7c3aed' : '#6b7280';
            var emailBadge = s.email_status === 'SENT' ? '<span class="au-badge success" style="font-size:9px">sent</span>'
                          : s.email_status === 'FAILED' ? '<span class="au-badge error" style="font-size:9px">failed</span>'
                          : s.email_status === 'PENDING' ? '<span class="au-badge loading" style="font-size:9px">pending</span>'
                          : '<span class="au-badge idle" style="font-size:9px">—</span>';
            var tradeFrag = s.trade_id ? s.trade_id.slice(0, 20) : '—';
            var z90 = m.Z90 != null ? Number(m.Z90).toFixed(2) : '—';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(s.fired_at)) + '</td>' +
                    '<td style="padding:6px 8px"><code style="font-size:11px">' + autoEsc(s.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px"><b>' + autoEsc(m.Pair || '—') + '</b></td>' +
                    '<td style="padding:6px 8px;color:' + typeColor + ';font-weight:600">' + autoEsc(s.event_type) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(s.direction || m.Action || '—') + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + (s.score != null ? s.score : '—') + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">' + z90 + '</td>' +
                    '<td style="padding:6px 8px">' + emailBadge + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:10px;color:#6b7280" title="' + autoEsc(s.trade_id || '') + '">' + autoEsc(tradeFrag) + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' events'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----- Run History tab ------------------------------------------------------
async function autoLoadPairsFamRuns(filterOverride) {
    var el = document.getElementById('au-pairs-fam-runs-content');
    var statusEl = document.getElementById('au-pairs-fam-runs-status');
    if (!el) return;
    var sel = document.getElementById('au-pairs-fam-runs-filter');
    var filter = filterOverride && typeof filterOverride === 'string' && filterOverride !== '[object Event]'
        ? filterOverride : (sel ? sel.value : 'all');
    if (sel && filter !== sel.value) sel.value = filter;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }

    try {
        var webhookStrats = await autoGetWebhookStrategyNames();
        var qs = '?order=started_at.desc&limit=200&select=id,strategy_name,started_at,finished_at,duration_ms,status,signals_generated,emails_sent,emails_failed,error';
        if (filter === 'failed')            qs += '&status=eq.FAILED';
        else if (filter === 'with_signals') qs += '&signals_generated=gt.0';
        var r = await fetch(SUPABASE_URL + '/rest/v1/auto_runs' + qs, { headers: wmsHeaders() });
        var all = r.ok ? await r.json() : [];
        var rows = (all || []).filter(function (rn) {
            return rn.strategy_name && !rn.strategy_name.startsWith('_') && !webhookStrats.has(rn.strategy_name);
        }).slice(0, 100);

        if (rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No pairs runs match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 runs'; }
            return;
        }
        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px">Started (IST)</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px;text-align:right">Signals</th>' +
                '<th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px;text-align:right">Duration</th>' +
                '<th style="padding:6px 8px">Error</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (rn) {
            var emailCell = '—';
            if (rn.emails_sent || rn.emails_failed) {
                var sent = rn.emails_sent || 0, failed = rn.emails_failed || 0;
                emailCell = (failed > 0 ? '<span style="color:#dc2626">' + failed + ' failed</span>' : '') +
                            (sent > 0 && failed > 0 ? ' / ' : '') +
                            (sent > 0 ? '<span style="color:#047857">' + sent + ' sent</span>' : '');
            }
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(rn.started_at)) + '</td>' +
                    '<td style="padding:6px 8px"><code style="font-size:11px">' + autoEsc(rn.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoStatusBadge(rn.status) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right">' + (rn.signals_generated != null ? rn.signals_generated : '—') + '</td>' +
                    '<td style="padding:6px 8px;font-size:11px">' + emailCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">' + autoFmtDuration(rn.duration_ms) + '</td>' +
                    '<td style="padding:6px 8px;color:#7f1d1d;font-size:11px;max-width:400px;overflow:hidden;text-overflow:ellipsis" title="' + autoEsc(rn.error || '') + '">' +
                        autoEsc((rn.error || '').slice(0, 100)) + (rn.error && rn.error.length > 100 ? '…' : '') +
                    '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' runs'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----- Controls & Admin tab -------------------------------------------------
async function autoLoadPairsFamAdmin() {
    var webhookStrats = await autoGetWebhookStrategyNames();

    // 1. Strategy config table
    var stratsEl = document.getElementById('au-pairs-fam-strategies');
    if (stratsEl) {
        try {
            var r = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?select=*', { headers: wmsHeaders() });
            var all = r.ok ? await r.json() : [];
            var rows = all.filter(function (s) { return s.name && !s.name.startsWith('_') && !webhookStrats.has(s.name); });
            if (rows.length === 0) {
                stratsEl.innerHTML = '<div class="au-soon">No pairs strategies configured.</div>';
            } else {
                var html = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
                html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                        '<th style="padding:6px 8px">Name</th>' +
                        '<th style="padding:6px 8px">Enabled</th>' +
                        '<th style="padding:6px 8px">Mode</th>' +
                        '<th style="padding:6px 8px">Version</th>' +
                        '<th style="padding:6px 8px">Metadata</th>' +
                        '</tr></thead><tbody>';
                rows.forEach(function (s) {
                    var meta = s.metadata ? JSON.stringify(s.metadata) : '—';
                    html += '<tr style="border-top:1px solid #e5e7eb">' +
                            '<td style="padding:6px 8px"><code>' + autoEsc(s.name) + '</code></td>' +
                            '<td style="padding:6px 8px">' + (s.enabled ? '<span class="au-badge success">yes</span>' : '<span class="au-badge error">no</span>') + '</td>' +
                            '<td style="padding:6px 8px"><b>' + autoEsc(s.execution_mode || '—') + '</b></td>' +
                            '<td style="padding:6px 8px;font-family:monospace">' + autoEsc(s.version || '—') + '</td>' +
                            '<td style="padding:6px 8px;font-family:monospace;font-size:10px;color:#6b7280;max-width:500px;overflow:hidden;text-overflow:ellipsis" title="' + autoEsc(meta) + '">' + autoEsc(meta.slice(0, 120)) + (meta.length > 120 ? '…' : '') + '</td>' +
                            '</tr>';
                });
                html += '</tbody></table>';
                stratsEl.innerHTML = html;
            }
        } catch (e) {
            stratsEl.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        }
    }

    // 2. Scheduling — cron-job.org "all enabled" cron hits automation-runner (no ?strategy=)
    //    5 fixed times/day. Freshness = latest auto_runs across any pairs strategy.
    var schedEl = document.getElementById('au-pairs-fam-scheduling');
    if (schedEl) {
        try {
            var lr = await fetch(SUPABASE_URL + '/rest/v1/auto_runs?order=finished_at.desc&limit=20&select=strategy_name,finished_at,status',
                { headers: wmsHeaders() });
            var runs = lr.ok ? await lr.json() : [];
            var last = runs.find(function (rn) {
                return rn.strategy_name && !rn.strategy_name.startsWith('_') && !webhookStrats.has(rn.strategy_name);
            });
            var lastCell, badgeCell;
            var STALE_MIN = 60 * 6;  // pairs runs at fixed times; 6h without a run = stale
            if (!last) {
                lastCell = '<span style="color:#9ca3af">never</span>';
                badgeCell = '<span class="au-badge idle" style="font-size:10px">no data</span>';
            } else {
                var ageMin = Math.round((Date.now() - new Date(last.finished_at).getTime()) / 60000);
                var stale = ageMin > STALE_MIN;
                var ago = ageMin < 60 ? (ageMin + 'm ago') : ageMin < 1440 ? (Math.round(ageMin/60) + 'h ago') : (Math.round(ageMin/1440) + 'd ago');
                lastCell = '<span title="' + autoEsc(autoFmtIST(last.finished_at)) + '">' + ago + ' · <code>' + autoEsc(last.strategy_name) + '</code></span>';
                badgeCell = stale ? '<span class="au-badge error" style="font-size:10px">STALE</span>' : '<span class="au-badge success" style="font-size:10px">OK</span>';
            }
            var html = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
            html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                    '<th style="padding:6px 8px">Job</th>' +
                    '<th style="padding:6px 8px">Endpoint (Edge Function)</th>' +
                    '<th style="padding:6px 8px">Cadence</th>' +
                    '<th style="padding:6px 8px">Last run</th>' +
                    '<th style="padding:6px 8px">Status</th>' +
                    '</tr></thead><tbody>';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><b>Pairs scan</b></td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:11px;color:#4b5563">automation-runner (no ?strategy= param)</td>' +
                    '<td style="padding:6px 8px;font-size:11px;color:#4b5563">5 fixed times/day · NSE hours</td>' +
                    '<td style="padding:6px 8px;font-size:11px">' + lastCell + '</td>' +
                    '<td style="padding:6px 8px">' + badgeCell + '</td>' +
                    '</tr></tbody></table>';
            html += '<div style="font-size:11px;color:#6b7280;margin-top:8px;line-height:1.5">' +
                    '• Runner iterates ALL enabled non-GS strategies on the pairs cron (per <code>EXPLICIT_ONLY_STRATEGIES</code> guard).<br>' +
                    '• GS is excluded from this cron path — it has its own 15-min crons (see GS → Controls &amp; Admin).' +
                    '</div>';
            schedEl.innerHTML = html;
        } catch (e) {
            schedEl.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        }
    }

    // 3. Universe — hard-coded in the strategy plugin; we can only show what
    //    signals reveal. Approximate by extracting unique pair labels from the
    //    last 90d of ENTRY signals.
    var uniEl = document.getElementById('au-pairs-fam-universe');
    if (uniEl) {
        try {
            var since90 = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
            var er = await fetch(SUPABASE_URL + '/rest/v1/auto_signals?event_type=eq.ENTRY&fired_at=gte.' + since90 + '&select=metadata,strategy_name',
                { headers: wmsHeaders() });
            var entries = er.ok ? (await er.json()).filter(function (s) {
                return s.strategy_name && !s.strategy_name.startsWith('_') && !webhookStrats.has(s.strategy_name);
            }) : [];
            var pairSet = new Set();
            entries.forEach(function (s) { if (s.metadata && s.metadata.Pair) pairSet.add(s.metadata.Pair); });
            var pairs = Array.from(pairSet).sort();
            if (pairs.length === 0) {
                uniEl.innerHTML = '<div style="color:#6b7280;font-size:12px">No entry signals in the last 90 days — universe cannot be inferred. Consult the strategy plugin source directly.</div>';
            } else {
                uniEl.innerHTML =
                    '<div style="font-size:12px;color:#4b5563;margin-bottom:6px"><b>' + pairs.length + '</b> unique pairs observed in the last 90d of ENTRY signals:</div>' +
                    '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
                    pairs.map(function (p) { return '<span style="background:#eff6ff;color:#1e40af;padding:2px 8px;border-radius:4px;font-size:11px;font-family:monospace">' + autoEsc(p) + '</span>'; }).join('') +
                    '</div>' +
                    '<div style="font-size:11px;color:#9ca3af;margin-top:8px">' +
                    'Note: this is inferred from signal history, not the strategy plugin\'s configured universe. Silent pairs (no entries in 90d) won\'t appear.' +
                    '</div>';
            }
        } catch (e) {
            uniEl.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        }
    }
}

// ============================================================================
// KH family page (Phase D — 2026-07-09)
//
// First UI presence for Katalysthive. KH does NOT go through auto_signals;
// its data lives in wms_live_commands (signal_source='katalysthive').
// The Controls & Admin sub-tab DOM-mirrors the Legacy Live Trading panel
// content — SAME live-enforcing widgets, no rebuild. Legacy panel stays fully
// functional in parallel until Phase E.
// ============================================================================

var _AU_KH_SRC = 'katalysthive';
var _auKhMetrics = {
    open: null, ingested24h: null, filled24h: null, rejected24h: null, errors24h: null,
    topRejectReason: null
};

function autoKhFamSetupMirror() {
    // Mirror the three Legacy Live Trading card content DIVs into KH family targets.
    // The buttons inside these DIVs (e.g. arm/disarm kill, KH pause, save risk cap)
    // have inline onclick handlers pointing to global functions that update the
    // shared _auLiveState — clicking on either surface routes through the same code.
    var pairs = [
        ['au-live-controls', 'au-kh-fam-live-controls'],
        ['au-live-kh',       'au-kh-fam-live-kh'],
        ['au-live-lotsizes', 'au-kh-fam-live-lotsizes']
    ];
    pairs.forEach(function (t) {
        var src = document.getElementById(t[0]);
        var dst = document.getElementById(t[1]);
        if (!src || !dst || src._auKhMirrored) return;
        src._auKhMirrored = true;
        dst.innerHTML = src.innerHTML;
        new MutationObserver(function () { dst.innerHTML = src.innerHTML; })
            .observe(src, { childList: true, subtree: true, characterData: true, attributes: true });
    });
    // The Legacy Live Trading badge (au-live-state-badge) also mirrors — it's the
    // little "live/paused" indicator next to "Live Controls".
    var badgeSrc = document.getElementById('au-live-state-badge');
    var badgeDst = document.getElementById('au-kh-fam-live-badge');
    if (badgeSrc && badgeDst && !badgeSrc._auKhBadgeMirrored) {
        badgeSrc._auKhBadgeMirrored = true;
        badgeDst.className = badgeSrc.className;
        badgeDst.textContent = badgeSrc.textContent;
        new MutationObserver(function () {
            badgeDst.className = badgeSrc.className;
            badgeDst.textContent = badgeSrc.textContent;
        }).observe(badgeSrc, { childList: true, subtree: true, characterData: true, attributes: true });
    }
    window._auKhFamMirrorReady = true;
}

function autoLoadKhFamRefresh() {
    autoLoadKhFamHeader();
    autoLoadKhFamMetrics();
    autoLoadKhFamOpen();
    autoLoadKhFamRecent();
    autoLoadKhFamRejections();
    // Ensure the Legacy Live Trading state loads so the mirrors have content to copy.
    if (typeof autoLoadLive === 'function' && !window._auLiveLoaded) {
        autoLoadLive();
        window._auLiveLoaded = true;
    }
}

// ----- Header (mode pill + last activity) ------------------------------------
async function autoLoadKhFamHeader() {
    try {
        var sr = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1&select=kill_switch,paused_sources',
            { headers: wmsHeaders() });
        var state = sr.ok ? (await sr.json())[0] || {} : {};
        var paused = (state.paused_sources || []).indexOf(_AU_KH_SRC) !== -1;
        var pill = document.getElementById('au-kh-fam-mode');
        if (pill) {
            if (state.kill_switch)  { pill.className = 'status-pill stopped'; pill.textContent = '🛑 KILL SWITCH'; }
            else if (paused)        { pill.className = 'status-pill paused';  pill.textContent = '⏸ PAUSED'; }
            else                    { pill.className = 'status-pill live';    pill.textContent = '🟢 LIVE'; }
        }
        // Last activity — most-recent wms_live_commands row
        var lr = await fetch(SUPABASE_URL + '/rest/v1/wms_live_commands?signal_source=eq.' + _AU_KH_SRC + '&order=created_at.desc&limit=1&select=created_at,status,broker_status,payload',
            { headers: wmsHeaders() });
        var last = lr.ok ? (await lr.json())[0] : null;
        var laEl = document.getElementById('au-kh-fam-lastact');
        if (laEl) {
            if (last) {
                var ago = Math.round((Date.now() - new Date(last.created_at).getTime()) / 60000);
                var agoStr = ago < 60 ? (ago + 'm ago') : ago < 1440 ? (Math.round(ago/60) + 'h ago') : (Math.round(ago/1440) + 'd ago');
                var sym = (last.payload && last.payload.symbol) || '';
                laEl.textContent = 'Last activity: ' + (last.broker_status || last.status) + (sym ? ' · ' + sym : '') + ' · ' + agoStr;
            } else {
                laEl.textContent = 'Last activity: no commands yet';
            }
        }
    } catch (_e) { /* silent */ }
}

// ----- Metrics --------------------------------------------------------------
async function autoLoadKhFamMetrics() {
    try {
        var since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        var results = await Promise.all([
            // Open commands (in-flight)
            fetch(SUPABASE_URL + "/rest/v1/wms_live_commands?signal_source=eq." + _AU_KH_SRC + "&status=in.(pending,claimed,placed)&broker_status=is.null&select=id", { headers: wmsHeaders() }),
            // Open commands with broker_status non-terminal
            fetch(SUPABASE_URL + "/rest/v1/wms_live_commands?signal_source=eq." + _AU_KH_SRC + "&status=eq.placed&broker_status=in.(PENDING,OPEN,PARTIAL)&select=id", { headers: wmsHeaders() }),
            // Ingested 24h — count all commands regardless of status
            fetch(SUPABASE_URL + "/rest/v1/wms_live_commands?signal_source=eq." + _AU_KH_SRC + "&created_at=gte." + since24 + "&select=id,status,broker_status,error_code", { headers: wmsHeaders() })
        ]);
        var openNoBroker  = results[0].ok ? await results[0].json() : [];
        var openNonTerm   = results[1].ok ? await results[1].json() : [];
        var last24        = results[2].ok ? await results[2].json() : [];

        _auKhMetrics.open        = openNoBroker.length + openNonTerm.length;
        _auKhMetrics.ingested24h = last24.length;
        _auKhMetrics.filled24h   = last24.filter(function (c) { return c.broker_status === 'FILLED'; }).length;
        _auKhMetrics.rejected24h = last24.filter(function (c) { return c.status === 'rejected'; }).length;
        _auKhMetrics.errors24h   = last24.filter(function (c) { return c.status === 'error'; }).length;

        // Top reject reason
        var codes = {};
        last24.forEach(function (c) {
            if (c.status === 'rejected' && c.error_code) codes[c.error_code] = (codes[c.error_code] || 0) + 1;
        });
        var top = Object.keys(codes).sort(function (a, b) { return codes[b] - codes[a]; })[0];
        _auKhMetrics.topRejectReason = top ? (top + ' (' + codes[top] + ')') : null;

        autoRenderKhFamMetrics();
    } catch (_e) { /* silent */ }
}

function autoRenderKhFamMetrics() {
    var t = _auKhMetrics;
    var setText = function (id, txt, cls) {
        var e = document.getElementById(id);
        if (!e) return;
        e.textContent = txt;
        if (cls !== undefined) e.className = 'metric-value ' + cls;
    };
    var setSub = function (id, txt) { var e = document.getElementById(id); if (e) e.textContent = txt || ''; };

    if (t.open != null)        { setText('au-kh-fam-metric-open', String(t.open), ''); setSub('au-kh-fam-metric-open-sub', 'pending / claimed / working'); }
    if (t.ingested24h != null) { setText('au-kh-fam-metric-ingested', String(t.ingested24h), ''); setSub('au-kh-fam-metric-ingested-sub', 'all statuses'); }
    if (t.filled24h != null)   { setText('au-kh-fam-metric-filled', String(t.filled24h), t.filled24h > 0 ? 'pos' : ''); setSub('au-kh-fam-metric-filled-sub', 'broker_status=FILLED'); }
    if (t.rejected24h != null) {
        setText('au-kh-fam-metric-rejected', String(t.rejected24h), t.rejected24h > 0 ? 'neg' : '');
        setSub('au-kh-fam-metric-rejected-sub', t.topRejectReason ? ('top: ' + t.topRejectReason) : 'status=rejected');
    }
    if (t.errors24h != null)   { setText('au-kh-fam-metric-errors', String(t.errors24h), t.errors24h > 0 ? 'neg' : ''); setSub('au-kh-fam-metric-errors-sub', 'status=error'); }
}

// ----- KH commands renderers ------------------------------------------------
function _autoKhStatusPill(status, brokerStatus) {
    var t = brokerStatus || status || '—';
    var cls = 'idle', color = '#6b7280';
    if (brokerStatus === 'FILLED')                                { cls = 'success'; color = '#047857'; }
    else if (brokerStatus === 'PARTIAL')                          { cls = 'loading'; color = '#0891b2'; }
    else if (brokerStatus === 'PENDING' || brokerStatus === 'OPEN'){ cls = 'loading'; color = '#0891b2'; }
    else if (brokerStatus === 'REJECTED')                         { cls = 'error';   color = '#dc2626'; }
    else if (brokerStatus === 'CANCELLED' || brokerStatus === 'EXPIRED') { cls = 'idle'; color = '#7f1d1d'; }
    else if (status === 'rejected')                               { cls = 'error';   color = '#dc2626'; }
    else if (status === 'error')                                  { cls = 'error';   color = '#dc2626'; }
    else if (status === 'placed')                                 { cls = 'loading'; color = '#0891b2'; }
    else if (status === 'claimed')                                { cls = 'loading'; color = '#0891b2'; }
    return '<span class="au-badge ' + cls + '" style="color:' + color + '">' + autoEsc(t) + '</span>';
}

function _autoKhCmdRow(c) {
    var p = c.payload || {};
    var symbol = p.symbol || '—';
    var side = p.side === 1 ? 'BUY' : p.side === -1 ? 'SELL' : (p.side || '—');
    var sideCell = side === 'BUY'  ? '<span class="au-badge success">BUY</span>'
                : side === 'SELL' ? '<span class="au-badge error">SELL</span>'
                : autoEsc(String(side));
    var qty = p.qty != null ? p.qty : '—';
    var filled = c.filled_qty != null ? c.filled_qty : 0;
    var qtyCell = qty + (filled > 0 && filled !== qty ? ' <span style="color:#0891b2;font-size:10px">(' + filled + ' filled)</span>' : '');
    var typeMap = { 1: 'LIMIT', 2: 'MARKET', 3: 'STOP', 4: 'STOPLIMIT' };
    var type = typeMap[p.type] || p.type || '—';
    var price = c.avg_fill_price != null ? autoFmtPrice0(Number(c.avg_fill_price))
              : (p.limitPrice != null ? autoFmtPrice0(Number(p.limitPrice)) : '—');
    var errCell = c.error_code
        ? '<span style="color:#dc2626;font-weight:600" title="' + autoEsc(c.error_message || '') + '">' + autoEsc(c.error_code) + '</span>'
        : '';
    return '<tr style="border-top:1px solid #e5e7eb">' +
           '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(c.created_at)) + '</td>' +
           '<td style="padding:6px 8px;font-family:monospace;font-size:11px">' + autoEsc(symbol) + '</td>' +
           '<td style="padding:6px 8px">' + sideCell + '</td>' +
           '<td style="padding:6px 8px;text-align:right">' + qtyCell + '</td>' +
           '<td style="padding:6px 8px;font-size:11px">' + autoEsc(String(type)) + '</td>' +
           '<td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">' + price + '</td>' +
           '<td style="padding:6px 8px">' + _autoKhStatusPill(c.status, c.broker_status) + '</td>' +
           '<td style="padding:6px 8px;font-family:monospace;font-size:10px;color:#6b7280">' + autoEsc(c.broker_order_id || '') + '</td>' +
           '<td style="padding:6px 8px;font-size:11px">' + errCell + '</td>' +
           '</tr>';
}

// ----- Open Commands tab ----------------------------------------------------
async function autoLoadKhFamOpen() {
    var el = document.getElementById('au-kh-fam-open-content');
    var badge = document.getElementById('au-kh-fam-open-badge');
    if (!el) return;
    if (badge) { badge.className = 'au-badge loading'; badge.textContent = 'loading'; }
    try {
        // Open = not-yet-terminal. Three categories:
        //  (a) status IN (pending, claimed) — Droplet hasn't finalized broker call
        //  (b) status=placed AND broker_status IN (PENDING, OPEN, PARTIAL) — with broker
        //  (c) status=placed AND broker_status IS NULL — placed but no update yet
        //      (rare + transient post-F2 orders-monitoring, but defensively included)
        var qs = '?signal_source=eq.' + _AU_KH_SRC +
                 '&or=(status.in.(pending,claimed),and(status.eq.placed,or(broker_status.is.null,broker_status.in.(PENDING,OPEN,PARTIAL))))' +
                 '&order=created_at.desc&limit=50' +
                 '&select=id,created_at,status,broker_status,broker_order_id,filled_qty,avg_fill_price,payload,error_code,error_message';
        var r = await fetch(SUPABASE_URL + '/rest/v1/wms_live_commands' + qs, { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No open Katalysthive commands.</div>';
            if (badge) { badge.className = 'au-badge idle'; badge.textContent = '0 open'; }
            return;
        }
        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px">Created (IST)</th>' +
                '<th style="padding:6px 8px">Symbol</th>' +
                '<th style="padding:6px 8px">Side</th>' +
                '<th style="padding:6px 8px;text-align:right">Qty</th>' +
                '<th style="padding:6px 8px">Type</th>' +
                '<th style="padding:6px 8px;text-align:right">Price</th>' +
                '<th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px">Broker order</th>' +
                '<th style="padding:6px 8px">Error</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (c) { html += _autoKhCmdRow(c); });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (badge) { badge.className = 'au-badge success'; badge.textContent = rows.length + ' open'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        if (badge) { badge.className = 'au-badge error'; badge.textContent = 'error'; }
    }
}

// ----- Recent Activity tab --------------------------------------------------
async function autoLoadKhFamRecent(filterOverride) {
    var el = document.getElementById('au-kh-fam-recent-content');
    var statusEl = document.getElementById('au-kh-fam-recent-status');
    var badge = document.getElementById('au-kh-fam-recent-badge');
    if (!el) return;
    var sel = document.getElementById('au-kh-fam-recent-filter');
    var filter = filterOverride && typeof filterOverride === 'string' && filterOverride !== '[object Event]'
        ? filterOverride : (sel ? sel.value : 'all');
    if (sel && filter !== sel.value) sel.value = filter;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
    if (badge) { badge.className = 'au-badge loading'; badge.textContent = 'loading'; }

    try {
        var qs = '?signal_source=eq.' + _AU_KH_SRC + '&order=created_at.desc&limit=100' +
                 '&select=id,created_at,status,broker_status,broker_order_id,filled_qty,avg_fill_price,payload,error_code,error_message';
        if (filter === 'terminal') qs += '&or=(status.in.(rejected,error,cancelled),broker_status.in.(FILLED,REJECTED,CANCELLED,EXPIRED))';
        else if (filter === 'rejected') qs += '&status=eq.rejected';
        var r = await fetch(SUPABASE_URL + '/rest/v1/wms_live_commands' + qs, { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No commands match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0'; }
            if (badge) { badge.className = 'au-badge idle'; badge.textContent = '0'; }
            return;
        }
        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left;position:sticky;top:0;z-index:1">' +
                '<th style="padding:6px 8px">Created (IST)</th>' +
                '<th style="padding:6px 8px">Symbol</th>' +
                '<th style="padding:6px 8px">Side</th>' +
                '<th style="padding:6px 8px;text-align:right">Qty</th>' +
                '<th style="padding:6px 8px">Type</th>' +
                '<th style="padding:6px 8px;text-align:right">Price</th>' +
                '<th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px">Broker order</th>' +
                '<th style="padding:6px 8px">Error</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (c) { html += _autoKhCmdRow(c); });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' rows'; }
        if (badge) { badge.className = 'au-badge success'; badge.textContent = rows.length; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
        if (badge) { badge.className = 'au-badge error'; badge.textContent = 'error'; }
    }
}

// ----- Rejections tab -------------------------------------------------------
async function autoLoadKhFamRejections() {
    var el = document.getElementById('au-kh-fam-rejections-content');
    if (!el) return;
    try {
        var since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        var qs = '?signal_source=eq.' + _AU_KH_SRC + '&status=eq.rejected&created_at=gte.' + since30 +
                 '&order=created_at.desc&limit=200&select=id,created_at,error_code,error_message,payload';
        var r = await fetch(SUPABASE_URL + '/rest/v1/wms_live_commands' + qs, { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        if (rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No rejections in the last 30 days. ✅</div>';
            return;
        }
        // Group by error_code for breakdown chart
        var byCode = {};
        rows.forEach(function (c) {
            var k = c.error_code || 'UNKNOWN';
            if (!byCode[k]) byCode[k] = { count: 0, latest: null, sample: null };
            byCode[k].count += 1;
            if (!byCode[k].latest || c.created_at > byCode[k].latest) {
                byCode[k].latest = c.created_at;
                byCode[k].sample = c.error_message || '';
            }
        });
        var codes = Object.keys(byCode).sort(function (a, b) { return byCode[b].count - byCode[a].count; });
        var maxCount = byCode[codes[0]].count;

        var html = '<div class="au-card"><h3>Rejection breakdown (last 30d)</h3>';
        html += '<div style="margin-top:12px;font-size:12px">';
        codes.forEach(function (code) {
            var info = byCode[code];
            var pct = Math.round((info.count / maxCount) * 100);
            html += '<div style="margin-bottom:8px">' +
                    '<div style="display:flex;justify-content:space-between;margin-bottom:2px">' +
                    '<b style="color:#7f1d1d">' + autoEsc(code) + '</b>' +
                    '<span style="color:#4b5563">' + info.count + ' · latest ' + autoEsc(autoFmtIST(info.latest)) + '</span>' +
                    '</div>' +
                    '<div style="background:#fee2e2;border-radius:4px;height:6px;overflow:hidden">' +
                    '<div style="background:#dc2626;height:100%;width:' + pct + '%"></div>' +
                    '</div>' +
                    (info.sample ? '<div style="font-size:11px;color:#6b7280;margin-top:2px">' + autoEsc(info.sample.slice(0, 200)) + '</div>' : '') +
                    '</div>';
        });
        html += '</div></div>';

        // Full list
        html += '<div class="au-card" style="margin-top:12px"><h3>All rejections (last 30d)</h3>';
        html += '<div style="overflow-x:auto;margin-top:8px"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Created (IST)</th>' +
                '<th style="padding:6px 8px">Symbol</th>' +
                '<th style="padding:6px 8px">Error code</th>' +
                '<th style="padding:6px 8px">Message</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (c) {
            var sym = (c.payload && c.payload.symbol) || '—';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap;font-family:monospace;font-size:11px">' + autoEsc(autoFmtIST(c.created_at)) + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:11px">' + autoEsc(sym) + '</td>' +
                    '<td style="padding:6px 8px;color:#7f1d1d;font-weight:600">' + autoEsc(c.error_code || 'UNKNOWN') + '</td>' +
                    '<td style="padding:6px 8px;font-size:11px;color:#4b5563">' + autoEsc((c.error_message || '').slice(0, 200)) + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div></div>';
        el.innerHTML = html;
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed: ' + autoEsc(String(e)) + '</span>';
    }
}

async function autoLoadGsFamHeader() {
    try {
        // Mode: read auto_strategies.execution_mode for silver + gold
        var sr = await fetch(SUPABASE_URL + '/rest/v1/auto_strategies?name=in.(silver_mini_15m,gold_mini_15m)&select=name,enabled,execution_mode,version',
            { headers: wmsHeaders() });
        var strategies = sr.ok ? await sr.json() : [];
        var pill = document.getElementById('au-gs-fam-mode');
        if (pill) {
            var anyLive = strategies.some(function (s) { return s.execution_mode === 'LIVE'; });
            var allEnabled = strategies.length > 0 && strategies.every(function (s) { return s.enabled; });
            if (anyLive)         { pill.className = 'status-pill live';    pill.textContent = '🟢 LIVE'; }
            else if (allEnabled) { pill.className = 'status-pill paper';   pill.textContent = '🟡 PAPER'; }
            else                 { pill.className = 'status-pill stopped'; pill.textContent = '⏹ DISABLED'; }
        }
        // Version: use the max version across strategies (they should all be v2.2).
        var vEl = document.getElementById('au-gs-fam-metric-version');
        if (vEl && strategies.length > 0) {
            var versions = Array.from(new Set(strategies.map(function (s) { return s.version || 'unknown'; })));
            vEl.textContent = versions.join(' / ');
        }
        // Last activity: most recent auto_signals row for GS strategies
        var ar = await fetch(SUPABASE_URL + '/rest/v1/auto_signals?strategy_name=in.(silver_mini_15m,gold_mini_15m)&order=fired_at.desc&limit=1&select=fired_at,event_type,strategy_name',
            { headers: wmsHeaders() });
        var last = ar.ok ? (await ar.json())[0] : null;
        var laEl = document.getElementById('au-gs-fam-lastact');
        if (laEl) {
            if (last) {
                var ago = Math.round((Date.now() - new Date(last.fired_at).getTime()) / 60000);
                var agoStr = ago < 60 ? (ago + 'm ago') : ago < 1440 ? (Math.round(ago/60) + 'h ago') : (Math.round(ago/1440) + 'd ago');
                laEl.textContent = 'Last activity: ' + last.event_type + ' · ' + last.strategy_name.replace('_mini_15m', '') + ' · ' + agoStr;
            } else {
                laEl.textContent = 'Last activity: no signals yet';
            }
        }
    } catch (e) {
        // Silent — header is nice-to-have, not critical
    }
}

function autoRenderGsFamMetrics() {
    var t = _auGsTotals || {};
    var fmt = function (n) { if (n == null) return '—'; return '₹' + Math.round(n).toLocaleString('en-IN'); };
    var fmtSigned = function (n) {
        if (n == null) return '—';
        var sign = n >= 0 ? '+' : '−';
        return sign + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN');
    };
    var setText = function (id, txt, cls) {
        var e = document.getElementById(id);
        if (!e) return;
        e.textContent = txt;
        if (cls !== undefined) e.className = 'metric-value ' + cls;
    };
    var setSub = function (id, txt) {
        var e = document.getElementById(id);
        if (e) e.textContent = txt || '';
    };

    // Open positions
    if (t.openCount != null) {
        setText('au-gs-fam-metric-open', t.openCount + (t.openCount === 1 ? ' trade' : ' trades'), '');
        setSub('au-gs-fam-metric-open-sub', t.openExposure != null ? ('exposure ' + fmt(t.openExposure)) : '');
    }
    // Live P&L on open
    if (t.openLivePnl != null) {
        var pnl = t.openLivePnl;
        setText('au-gs-fam-metric-livepnl', fmtSigned(pnl), pnl >= 0 ? 'pos' : 'neg');
        var pct = null;
        if (t.openExposure && t.openExposure !== 0) pct = (pnl / t.openExposure) * 100;
        setSub('au-gs-fam-metric-livepnl-sub', pct != null ? ((pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(2) + '% of exposure') : '');
    } else if (t.openCount === 0) {
        setText('au-gs-fam-metric-livepnl', '—', '');
        setSub('au-gs-fam-metric-livepnl-sub', 'no open positions');
    }
    // Realised (all-time closed)
    if (t.closedRealisedPnl != null) {
        setText('au-gs-fam-metric-realised', fmtSigned(t.closedRealisedPnl), t.closedRealisedPnl >= 0 ? 'pos' : 'neg');
        var w = t.closedWins || 0, l = t.closedLosses || 0, tot = w + l;
        setSub('au-gs-fam-metric-realised-sub', tot > 0 ? (w + ' wins · ' + l + ' losses · ' + tot + ' closed') : '');
    }
    // Peak exposure — respects the source filter (chassis-only / tv_webhook-only / all)
    if (t.peakExposure != null) {
        setText('au-gs-fam-metric-peak', fmt(t.peakExposure), '');
        var srcLabel = '';
        if (t.peakSourceFilter === 'chassis')    srcLabel = ' · runner only';
        else if (t.peakSourceFilter === 'tv_webhook') srcLabel = ' · TV webhook only';
        setSub('au-gs-fam-metric-peak-sub',
            (t.peakMargin != null ? ('peak margin ' + fmt(t.peakMargin)) : '') + srcLabel);
    }
}

// ----------------------------------------------------------------------------
// Health page renderers (Phase A — kill switch + families board + crons + errors)
// ----------------------------------------------------------------------------

function autoHealthLoadAll() {
    autoHealthLoadKill();
    autoHealthLoadFamilies();
    autoHealthLoadCrons();
    autoHealthLoadErrors();
}

// ----------------------------------------------------------------------------
// Health page — Platform Maintenance mirrors (2026-07-09).
// Ported the Legacy Admin utilities (EOD ingest, market_prices snapshot,
// Strategy Runner) to the Health page via DOM mirroring of Legacy state
// elements. Buttons on both surfaces call the same global handlers (which
// update Legacy IDs); observers propagate the visual state to Health.
// ----------------------------------------------------------------------------
function autoHealthSetupPlatformMirrors() {
    if (window._auHpMirrorsReady) return;
    var pairs = [
        // EOD ingest
        ['au-eod-status',      'au-hp-eod-status',      'badge'],
        ['au-eod-last-run',    'au-hp-eod-last-run',    'content'],
        ['au-eod-response',    'au-hp-eod-response',    'content'],
        // market_prices snapshot
        ['au-mp-stats',        'au-hp-mp-stats',        'content'],
        // Strategy Runner
        ['au-runner-status',   'au-hp-runner-status',   'badge'],
        ['au-runner-last-run', 'au-hp-runner-last-run', 'content'],
        ['au-runner-response', 'au-hp-runner-response', 'content']
    ];
    pairs.forEach(function (t) {
        var src = document.getElementById(t[0]);
        var dst = document.getElementById(t[1]);
        if (!src || !dst) return;
        var mode = t[2];
        var applyOnce = function () {
            if (mode === 'badge') {
                dst.className = src.className;
                dst.textContent = src.textContent;
            } else {
                dst.innerHTML = src.innerHTML;
                // Sync display state (response panels toggle display:block on show)
                if (src.style && src.style.cssText != null) dst.style.cssText = src.style.cssText;
            }
        };
        applyOnce();
        new MutationObserver(applyOnce).observe(src, {
            childList: true, subtree: true, characterData: true, attributes: true
        });
    });
    window._auHpMirrorsReady = true;
}

var _auHealthState = null;

async function autoHealthLoadKill() {
    try {
        var r = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1&select=kill_switch,paused_sources,updated_at,updated_by,updated_reason',
            { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        _auHealthState = (rows && rows[0]) || { kill_switch: false, paused_sources: [] };
        autoHealthRenderKill();
    } catch (e) {
        var el = document.getElementById('au-health-kill-label');
        if (el) el.textContent = 'Failed to load: ' + (e.message || e);
    }
}

function autoHealthRenderKill() {
    var s = _auHealthState || {};
    var on = !!s.kill_switch;
    var badge = document.getElementById('au-health-kill-badge');
    var label = document.getElementById('au-health-kill-label');
    var btn   = document.getElementById('au-health-kill-btn');
    var meta  = document.getElementById('au-health-kill-meta');
    if (badge) {
        badge.className = 'status-pill ' + (on ? 'stopped' : 'live');
        badge.textContent = on ? 'TRIPPED' : 'ARMED';
    }
    if (label) {
        label.className = 'kill-state-label ' + (on ? 'tripped' : 'armed');
        label.textContent = on ? '🛑 Kill switch is TRIPPED — ALL strategies halted' : '✅ Kill switch is ARMED — strategies allowed to trade';
    }
    if (btn) {
        btn.disabled = false;
        btn.className = 'kill-btn ' + (on ? 'arm' : 'trip');
        btn.textContent = on ? 'Resume all' : 'Trip kill switch';
    }
    if (meta) {
        var ts = s.updated_at ? new Date(s.updated_at).toLocaleString() : '';
        var who = s.updated_by || '';
        var why = s.updated_reason || '';
        meta.textContent = ts ? ('Last change: ' + ts + (who ? ' by ' + who : '') + (why ? ' — ' + why : '')) : '';
    }
}

async function autoHealthToggleKill() {
    if (!_auHealthState) return;
    var on = !!_auHealthState.kill_switch;
    var msg = on
        ? 'Resume — turn the kill switch OFF?\n\nAll LIVE order placement is re-enabled from the next signal onwards.'
        : '⚠️ TRIP the master kill switch?\n\nHalts all LIVE order placement broker-wide:\n• Katalysthive inbound signals are rejected (HTTP 503 KILL_SWITCH)\n• Droplet stops dispensing queued orders (poller returns kill_switch:true)\n\nReversible — toggle OFF to resume. No queue is destroyed, no data is lost.\n\nGS PAPER continues writing signals to auto_signals (chassis doesn\'t check kill_switch yet — see task #43); no orders reach any broker regardless.';
    if (!confirm(msg)) return;
    try {
        var patch = {
            kill_switch: !on,
            updated_by: (window.currentUser && window.currentUser.email) || 'app',
            updated_reason: (on ? 'Resume from' : 'Trip') + ' kill switch (Health page)'
        };
        var r = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1',
            { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: JSON.stringify(patch) });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()));
        autoHealthLoadKill();
        // Legacy Live Trading tab caches its own copy — force a reload next time it opens.
        window._auLiveLoaded = false;
    } catch (e) {
        alert('Failed to toggle kill switch: ' + (e.message || e));
    }
}

async function autoHealthLoadFamilies() {
    var tbody = document.getElementById('au-health-families-body');
    if (!tbody) return;
    try {
        var results = await Promise.all([
            fetch(SUPABASE_URL + '/rest/v1/auto_strategies?select=name,enabled,execution_mode,version', { headers: wmsHeaders() }),
            fetch(SUPABASE_URL + '/rest/v1/v_auto_open_trades?select=strategy_name,net_qty', { headers: wmsHeaders() }),
            fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1&select=kill_switch,paused_sources', { headers: wmsHeaders() }),
            fetch(SUPABASE_URL + '/rest/v1/wms_live_commands?signal_source=eq.katalysthive&status=in.(PENDING,WORKING,PLACED)&select=trade_id,quantity', { headers: wmsHeaders() })
        ]);
        var strategies = results[0].ok ? await results[0].json() : [];
        var openLegs   = results[1].ok ? await results[1].json() : [];
        var stateRows  = results[2].ok ? await results[2].json() : [];
        var khOpen     = results[3].ok ? await results[3].json() : [];
        var state = (stateRows && stateRows[0]) || { kill_switch: false, paused_sources: [] };
        var paused = state.paused_sources || [];

        var GS_NAMES = ['silver_mini_15m', 'gold_mini_15m'];
        var families = [
            { key: 'gs',    label: '🥈🥇 GS — Silver & Gold Mini', matcher: function (n) { return GS_NAMES.indexOf(n) !== -1; }, sources: ['chassis', 'tv_webhook'] },
            { key: 'kh',    label: '🐦 Katalysthive — sharanaga_v1', matcher: null, sources: ['katalysthive'], external: true },
            { key: 'pairs', label: '🔗 Pairs Scanner',              matcher: function (n) { return n && n.indexOf('pairs') === 0; }, sources: ['chassis'] }
        ];

        var rows = families.map(function (f) {
            if (f.external) {
                var isPaused = paused.indexOf('katalysthive') !== -1;
                var status, statusLabel;
                if (state.kill_switch) { status = 'stopped'; statusLabel = '🛑 STOPPED'; }
                else if (isPaused)     { status = 'paused';  statusLabel = '⏸ PAUSED'; }
                else                   { status = 'live';    statusLabel = '🟢 LIVE'; }
                return { key: f.key, label: f.label, mode: 'LIVE', status: status, statusLabel: statusLabel, open: khOpen.length + ' cmd', pnl: '—', activity: '—' };
            }
            var matching = strategies.filter(function (s) { return f.matcher(s.name); });
            var enabled = matching.some(function (s) { return s.enabled; });
            var mode = matching.some(function (s) { return s.execution_mode === 'LIVE'; }) ? 'LIVE' : 'PAPER';
            var openLots = openLegs.filter(function (l) { return f.matcher(l.strategy_name); }).length;
            var isPaused = f.sources.some(function (src) { return paused.indexOf(src) !== -1; });
            var status = 'building', statusLabel = '🔨 EMPTY';
            if (matching.length > 0) {
                if (state.kill_switch)      { status = 'stopped'; statusLabel = '🛑 STOPPED'; }
                else if (!enabled)          { status = 'stopped'; statusLabel = '⏹ DISABLED'; }
                else if (isPaused)          { status = 'paused';  statusLabel = '⏸ PAUSED'; }
                else if (mode === 'LIVE')   { status = 'live';    statusLabel = '🟢 LIVE'; }
                else                        { status = 'paper';   statusLabel = '🟡 PAPER'; }
            }
            return { key: f.key, label: f.label, mode: mode, status: status, statusLabel: statusLabel, open: openLots + ' legs', pnl: '—', activity: '—' };
        });

        tbody.innerHTML = rows.map(function (r) {
            return '<tr class="clickable" onclick="autoSwitchFamily(\'' + r.key + '\')">'
                + '<td><b>' + r.label + '</b></td>'
                + '<td>' + r.mode + '</td>'
                + '<td><span class="status-pill ' + r.status + '">' + r.statusLabel + '</span></td>'
                + '<td>' + r.open + '</td>'
                + '<td>' + r.pnl + '</td>'
                + '<td>' + r.activity + '</td>'
                + '</tr>';
        }).join('');
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" style="color:#b91c1c;padding:12px">Failed: ' + (e.message || e) + '</td></tr>';
    }
}

async function autoHealthLoadCrons() {
    var el = document.getElementById('au-health-crons');
    if (!el) return;
    var jobs = [
        { name: 'automation-runner (5-min)', strategy: null,           staleMinutes: 15 },
        { name: 'eod-prices-ingest (daily)', strategy: '_eod_ingest',  staleMinutes: 60 * 30 },
        { name: 'fyers-auto-login (daily)',  strategy: '_fyers_login', staleMinutes: 60 * 30 }
    ];
    try {
        var results = await Promise.all(jobs.map(function (j) {
            var q = j.strategy
                ? '/rest/v1/auto_runs?strategy_name=eq.' + encodeURIComponent(j.strategy) + '&order=finished_at.desc&limit=1&select=finished_at,status'
                : '/rest/v1/auto_runs?order=finished_at.desc&limit=1&select=finished_at,status';
            return fetch(SUPABASE_URL + q, { headers: wmsHeaders() }).then(function (r) { return r.ok ? r.json() : []; });
        }));
        var now = Date.now();
        el.innerHTML = jobs.map(function (j, i) {
            var row = results[i][0];
            if (!row || !row.finished_at) {
                return '<li><span class="cron-name">' + j.name + '</span><span class="cron-time">never</span><span class="cron-badge na">no data</span></li>';
            }
            var ageMin = Math.round((now - new Date(row.finished_at).getTime()) / 60000);
            var stale = ageMin > j.staleMinutes;
            var label = ageMin < 60 ? (ageMin + 'm ago') : ageMin < 1440 ? (Math.round(ageMin / 60) + 'h ago') : (Math.round(ageMin / 1440) + 'd ago');
            return '<li><span class="cron-name">' + j.name + '</span><span class="cron-time">' + label + '</span><span class="cron-badge ' + (stale ? 'stale' : 'ok') + '">' + (stale ? 'STALE' : 'OK') + '</span></li>';
        }).join('');
    } catch (e) {
        el.innerHTML = '<li><span class="cron-name">Load failed</span><span class="cron-badge stale">' + (e.message || e) + '</span></li>';
    }
}

async function autoHealthLoadErrors() {
    var el = document.getElementById('au-health-errors');
    if (!el) return;
    try {
        var since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        var q = '/rest/v1/auto_runs?status=eq.error&started_at=gte.' + since + '&order=started_at.desc&limit=20&select=strategy_name,started_at,error_message';
        var r = await fetch(SUPABASE_URL + q, { headers: wmsHeaders() });
        var rows = r.ok ? await r.json() : [];
        if (rows.length === 0) {
            el.innerHTML = '<div style="color:#16a34a;font-weight:600">✅ No failed runs in the last 24h.</div>';
            return;
        }
        el.innerHTML = '<div style="color:#b91c1c;font-weight:600;margin-bottom:6px">' + rows.length + ' failed run(s) in last 24h</div>'
            + '<ul style="list-style:none;padding:0;margin:0;max-height:200px;overflow-y:auto">'
            + rows.map(function (r) {
                var ago = Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000);
                var msg = (r.error_message || '').substring(0, 100);
                return '<li style="padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:11px">'
                    + '<b>' + r.strategy_name + '</b> — ' + ago + 'm ago<br>'
                    + '<span style="color:#7f1d1d">' + msg + '</span></li>';
            }).join('')
            + '</ul>';
    } catch (e) {
        el.innerHTML = '<div style="color:#b91c1c">Failed: ' + (e.message || e) + '</div>';
    }
}

// GS Open Trades live P&L flows through the SINGLE app-wide price system
// (wms-shared.js → wmsStandardRefresh / wmsLivePrices / wmsStartRefreshTimer).
// No module-local timer or Fyers fetch — the shared timer keeps wmsLivePrices
// warm on the app cadence (10s equity, 2-min MCX evening) and its
// wmsRefreshRender() calls autoOnSharedRefresh() each cycle to re-render.
// (AUTOMATION-LESSONS Part 1; WMS-LESSONS §E.11.10)

// Symbols the open-trade views need priced; merged into the shared refresh list
// via wmsRegisterRefreshSymbolProvider. Updated whenever GS open trades load.
var _auGsSyms = [];     // GS (commodity) open-trade symbols [{ fyersKey, cacheKey }]
var _auPairsSyms = [];  // Pairs (equity) open-trade symbols
function autoGetRefreshSymbols() { return _auGsSyms.concat(_auPairsSyms); }

// Register the provider (idempotent) + make sure the single shared timer runs
// while the user is on the Open Trades tab. Called from autoSwitchTab.
function autoEnsureSharedRefresh() {
    if (typeof wmsRegisterRefreshSymbolProvider === 'function') {
        wmsRegisterRefreshSymbolProvider('auto_open_trades', autoGetRefreshSymbols);
    }
    if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
    if (typeof wmsStartRefreshTimer === 'function' && typeof wmsIsRefreshWindow === 'function'
        && wmsIsRefreshWindow() && window.fyersToken) {
        wmsStartRefreshTimer();
    }
}

// Called by wms-shared.js wmsRefreshRender() on every shared price cycle.
// Re-renders the GS open trades (reading LTP from wmsLivePrices) only while the
// user is viewing that sub-tab.
function autoOnSharedRefresh() {
    if (document.hidden) return;
    // GS live-price refresh triggers from EITHER surface:
    //   (a) new GS family page → Open Trades sub-tab
    //   (b) Legacy view → Open Trades tab → GS sub-tab (mirroring keeps both fresh)
    var legacyOpen  = document.getElementById('au-open-trades')?.classList.contains('active');
    var famGs       = document.getElementById('au-fam-gs')?.classList.contains('active');
    var famOpenTab  = document.getElementById('au-gs-fam-open-panel')?.classList.contains('active');
    var famPairs      = document.getElementById('au-fam-pairs')?.classList.contains('active');
    var famPairsOpen  = document.getElementById('au-pairs-fam-open-panel')?.classList.contains('active');
    var gsActive    = (legacyOpen && document.getElementById('au-ot-gs')?.classList.contains('active'))
                   || (famGs && famOpenTab);
    var pairsActive = (legacyOpen && document.getElementById('au-ot-pairs')?.classList.contains('active'))
                   || (famPairs && famPairsOpen);
    if (gsActive)    autoLoadGsOpenTrades(true /* silent — flicker-free */);
    if (pairsActive) autoLoadOpenTrades(true /* silent — flicker-free */);
    autoUpdateGsRefreshTickStatus(
        (typeof wmsIsRefreshWindow === 'function' && wmsIsRefreshWindow()) ? 'live' : 'off-hours');
}

function autoUpdateGsRefreshTickStatus(state) {
    var tick = document.getElementById('au-gs-refresh-tick');
    var label = document.getElementById('au-gs-refresh-label');
    if (!tick || !label) return;
    if (state === 'live')        { tick.classList.remove('paused'); label.textContent = 'live'; }
    else if (state === 'paused') { tick.classList.add('paused');    label.textContent = 'paused'; }
    else if (state === 'off-hours') { tick.classList.add('paused'); label.textContent = 'mkt closed'; }
}

// Sticky GS totals state — populated by both autoLoadGsOpenTrades and
// autoLoadGsClosedTrades. autoUpdateGsTotalsBar reads it and writes to the bar.
//
// peakExposure / peakMargin are the HIGH-WATER marks across all signal time
// (entries add, exits subtract the matching entry's value). They represent
// the MAX simultaneous capital at risk at any point since the first trade.
// Recomputed every time autoLoadGsClosedTrades runs (since it already pulls
// every webhook signal — closed AND still-open).
var _auGsTotals = {
    openCount: null, openExposure: null, openMargin: null, openLivePnl: null,
    closedCount: null, closedWins: null, closedLosses: null, closedRealisedPnl: null,
    peakExposure: null, peakMargin: null,
};

// True only when the GS Open Trades view is the active panel — i.e. main tab =
// Open Trades AND sub-tab = GS. Because the totals bar is position:fixed it
// floats above every view, so we must explicitly suppress it on every other
// tab/sub-tab combo.
function autoIsGsViewActive() {
    // Legacy family panel wraps the old sub-tabs — the fixed totals bar must
    // stay hidden when the user is on Health / GS / KH / Pairs family pages.
    var legacyFam = document.getElementById('au-fam-legacy');
    if (legacyFam && !legacyFam.classList.contains('active')) return false;
    var mainPanel = document.getElementById('au-open-trades');
    if (!mainPanel || !mainPanel.classList.contains('active')) return false;
    var gsPanel = document.getElementById('au-ot-gs');
    return !!(gsPanel && gsPanel.classList.contains('active'));
}

function autoUpdateGsTotalsBar() {
    var bar = document.getElementById('au-gs-totals-bar');
    if (!bar) return;
    var t = _auGsTotals;
    var hasOpen = t.openCount != null;
    var hasClosed = t.closedCount != null;
    // Hide if GS view isn't active OR we have no data. The body class controls
    // bottom padding so the last table row isn't covered by the fixed bar.
    if (!autoIsGsViewActive() || (!hasOpen && !hasClosed)) {
        bar.style.display = 'none';
        document.body.classList.remove('au-totals-bar-visible');
        return;
    }
    bar.style.display = 'flex';
    document.body.classList.add('au-totals-bar-visible');

    var fmtFlat = function (n) {
        if (n == null) return '—';
        return '₹' + Math.round(n).toLocaleString('en-IN');
    };

    // Max Exposure / Max Margin = PEAK simultaneous capital at risk across
    // all signal time since first trade (entries add, exits subtract the
    // matching entry's value). Computed in autoLoadGsClosedTrades.
    document.getElementById('au-gs-tb-exp').textContent = t.peakExposure != null
        ? fmtFlat(t.peakExposure) : '—';
    document.getElementById('au-gs-tb-mgn').textContent = t.peakMargin != null
        ? fmtFlat(t.peakMargin) : '—';

    // Net P&L = open live P&L + closed realised P&L. % is against Max Exposure (peak).
    var netPnl = (t.openLivePnl || 0) + (t.closedRealisedPnl || 0);
    var anyPnl = (t.openLivePnl != null) || (t.closedRealisedPnl != null);
    var netCell = document.getElementById('au-gs-tb-net');
    if (anyPnl) {
        var col = netPnl >= 0 ? '#047857' : '#dc2626';
        var sign = netPnl >= 0 ? '+' : '−';
        var amt = '₹' + Math.abs(Math.round(netPnl)).toLocaleString('en-IN');
        var pctHtml = '';
        if (t.peakExposure && t.peakExposure > 0) {
            var pct = (netPnl / t.peakExposure) * 100;
            var pctSign = pct >= 0 ? '+' : '−';
            pctHtml = ' <span style="font-weight:500;font-size:11px;color:' + col + '">(' + pctSign + Math.abs(pct).toFixed(2) + '%)</span>';
        }
        netCell.innerHTML = '<span style="color:' + col + ';font-weight:700">' + sign + amt + '</span>' + pctHtml;
    } else {
        netCell.innerHTML = '—';
    }
}

// Sub-tab switcher (currently used inside the Open Trades tab to split GS vs Pairs).
// Sub-tab buttons + panels are scoped to a single parent tab panel; only buttons/panels
// within the same parent toggle (so multiple sub-tab groups can co-exist later if needed).
function autoSwitchSubTab(subtabId) {
    var panel = document.getElementById(subtabId);
    if (!panel) return;
    var parent = panel.parentElement;
    if (!parent) return;
    parent.querySelectorAll('.au-subtab-btn').forEach(function (b) { b.classList.remove('active'); });
    parent.querySelectorAll('.au-subtab-panel').forEach(function (p) { p.classList.remove('active'); });
    var btn = parent.querySelector('.au-subtab-btn[data-subtab="' + subtabId + '"]');
    if (btn) btn.classList.add('active');
    panel.classList.add('active');

    // Update refresh tick visual state — live P&L re-renders while the GS sub-tab
    // is active (driven by the shared app-wide price timer).
    if (subtabId === 'au-ot-gs') {
        autoUpdateGsRefreshTickStatus(
            (typeof wmsIsRefreshWindow === 'function' && wmsIsRefreshWindow()) ? 'live' : 'off-hours');
        autoEnsureSharedRefresh();
    } else {
        autoUpdateGsRefreshTickStatus('paused');
    }

    // Refresh fixed-bar visibility on sub-tab switch (Pairs ↔ GS)
    autoUpdateGsTotalsBar();
}

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------

async function initAutomation() {
    // Family tabs (Phase A of UI reimagining) — outer nav [Health][GS][KH][Pairs][Legacy]
    document.querySelectorAll('.au-fam-tab-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            if (!btn.disabled && btn.dataset.fam) autoSwitchFamily(btn.dataset.fam);
        });
    });

    // Wire tab buttons (Legacy view: Admin/Open/Events/Runs/Live)
    document.querySelectorAll('.automation-tab-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { autoSwitchTab(btn.dataset.tab); });
    });

    // Wire sub-tab buttons (Open Trades: GS vs Pairs)
    document.querySelectorAll('.au-subtab-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { autoSwitchSubTab(btn.dataset.subtab); });
    });

    // Health page is the default landing tab — set up platform-utility mirrors
    // BEFORE the parallel admin loads below so the initial state is captured,
    // then load Health data + auto-refresh every 30s.
    autoHealthSetupPlatformMirrors();
    autoHealthLoadAll();
    window._auHealthLoaded = true;
    if (!window._auHealthTimer) {
        window._auHealthTimer = setInterval(function () {
            var el = document.getElementById('au-fam-health');
            if (el && el.classList.contains('active')) autoHealthLoadAll();
        }, 30000);
    }

    // Load admin-tab data in parallel — still cheap, and warmed for the moment the
    // user opens Legacy view.
    autoLoadEodLastRun();
    autoLoadMarketPricesStats();
    autoLoadStrategies();
    autoLoadRunnerLastRun();
    autoLoadWebhookStatus();
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
        // ?wait=true → synchronous mode (function awaits completion before
        // responding). cron-job.org uses async-default to avoid its 30s
        // HTTP timeout, but here the user IS waiting for the answer in the UI.
        var resp = await fetch(SUPABASE_URL + '/functions/v1/eod-prices-ingest?wait=true', {
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
    // Class-based selector so both Legacy Admin (au-admin) and the new Health
    // page platform-maintenance card get disabled simultaneously.
    document.querySelectorAll('.au-eod-btn').forEach(function (b) {
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
// Strategy Runner — invoke automation-runner Edge Function + render response
// ----------------------------------------------------------------------------

var _autoRunnerInFlight = false;

async function autoRunStrategy(stratName) {
    if (_autoRunnerInFlight) return;
    _autoRunnerInFlight = true;

    autoSetRunnerStatus('loading', stratName ? 'running ' + stratName : 'running all');
    autoSetRunnerButtonsDisabled(true);

    var responsePanel = document.getElementById('au-runner-response');
    responsePanel.style.display = 'block';
    responsePanel.innerHTML = '<div class="au-meta">⏳ Running strategy ' + (stratName || '(all enabled)') + '… (~1-3s for stub, longer for real strategies)</div>';

    var qs = '?wait=true';
    if (stratName) qs += '&strategy=' + encodeURIComponent(stratName);

    var startedAt = Date.now();
    try {
        var resp = await fetch(SUPABASE_URL + '/functions/v1/automation-runner' + qs, {
            method: 'POST',
            headers: wmsEdgeHeaders({ 'Content-Type': 'application/json' }),
            body: '{}'
        });
        var text = await resp.text();
        var data;
        try { data = JSON.parse(text); } catch (_e) { data = { raw_response: text }; }
        var ms = Date.now() - startedAt;
        if (resp.ok && data && data.success) {
            autoSetRunnerStatus('success', 'success');
            autoRenderRunnerSuccess(data, ms);
        } else {
            autoSetRunnerStatus('error', 'failed');
            autoRenderRunnerError(data, resp.status, ms);
        }
    } catch (err) {
        autoSetRunnerStatus('error', 'failed');
        autoRenderRunnerError({ error: String(err) }, 0, Date.now() - startedAt);
    } finally {
        _autoRunnerInFlight = false;
        autoSetRunnerButtonsDisabled(false);
        autoLoadRunnerLastRun();
    }
}

function autoSetRunnerStatus(cls, label) {
    var el = document.getElementById('au-runner-status');
    if (!el) return;
    el.className = 'au-badge ' + cls;
    el.textContent = label;
}

function autoSetRunnerButtonsDisabled(disabled) {
    // Class-based selector so both Legacy runner card and the new Health page
    // runner card get disabled simultaneously.
    document.querySelectorAll('.au-runner-btn').forEach(function (b) {
        b.disabled = disabled;
    });
}

function autoRenderRunnerSuccess(d, ms) {
    var rp = document.getElementById('au-runner-response');
    var html = '<div style="font-size:13px;color:#047857;font-weight:600">✓ Dispatch Success <span class="au-badge success">' + (ms / 1000).toFixed(1) + 's</span></div>';

    var results = d.results || [];
    if (results.length === 0) {
        html += '<div class="au-warn-list" style="margin-top:8px">No strategies ran (none enabled, or filter excluded all).</div>';
    } else {
        html += '<div class="au-stat-grid">';
        html += autoStatBlock('Strategies run', d.strategies_run || 0);
        html += autoStatBlock('Total signals', results.reduce(function (a, r) { return a + (r.signals_generated || 0); }, 0));
        html += autoStatBlock('Emails sent', results.reduce(function (a, r) { return a + (r.emails_sent || 0); }, 0));
        html += autoStatBlock('Emails failed', results.reduce(function (a, r) { return a + (r.emails_failed || 0); }, 0));
        html += '</div>';

        // Per-strategy breakdown
        html += '<div style="margin-top:10px"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Strategy</th><th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px">Signals</th><th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px">Duration</th><th style="padding:6px 8px">Error</th></tr></thead><tbody>';
        results.forEach(function (r) {
            var statusBadge = r.status === 'SUCCESS'
                ? '<span class="au-badge success">success</span>'
                : '<span class="au-badge error">failed</span>';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(r.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + statusBadge + '</td>' +
                    '<td style="padding:6px 8px">' + (r.signals_generated || 0) + '</td>' +
                    '<td style="padding:6px 8px">' + (r.emails_sent ? '✓' : (r.emails_failed ? '✗' : '—')) + '</td>' +
                    '<td style="padding:6px 8px">' + ((r.duration_ms || 0) / 1000).toFixed(1) + 's</td>' +
                    '<td style="padding:6px 8px;color:#7f1d1d;font-size:11px">' + autoEsc(r.error || '') + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
    }

    html += '<details style="margin-top:10px"><summary>Full JSON response</summary>';
    html += '<pre class="au-result-block">' + autoEsc(JSON.stringify(d, null, 2)) + '</pre></details>';
    rp.innerHTML = html;
}

function autoRenderRunnerError(d, status, ms) {
    var rp = document.getElementById('au-runner-response');
    var html = '<div style="font-size:13px;color:#dc2626;font-weight:600">✗ Failed' + (status ? ' (HTTP ' + status + ')' : '') + ' <span class="au-badge error">' + (ms / 1000).toFixed(1) + 's</span></div>';
    if (d && d.error) html += '<div style="margin-top:6px;color:#7f1d1d;font-size:13px">' + autoEsc(d.error) + '</div>';
    html += '<details style="margin-top:10px" open><summary>Full JSON response</summary>';
    html += '<pre class="au-result-block">' + autoEsc(JSON.stringify(d, null, 2)) + '</pre></details>';
    rp.innerHTML = html;
}

async function autoLoadRunnerLastRun() {
    var el = document.getElementById('au-runner-last-run');
    if (!el) return;
    el.textContent = 'Loading last run…';
    try {
        // Skip _eod_ingest sentinel — that has its own card.
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_runs?strategy_name=neq._eod_ingest&order=started_at.desc&limit=1',
            { headers: wmsHeaders() }
        );
        var rows = await resp.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<em style="color:#9ca3af">No strategy runs yet — try the buttons above.</em>';
            autoSetRunnerStatus('idle', 'never run');
            return;
        }
        var r = rows[0];
        var dt = new Date(r.started_at);
        var when = dt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        var dur = r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + 's' : '—';
        var statusBadge = r.status === 'SUCCESS' ? '<span class="au-badge success">success</span>' :
                          r.status === 'FAILED'  ? '<span class="au-badge error">failed</span>' :
                                                   '<span class="au-badge loading">running</span>';
        el.innerHTML =
            '<span><strong>Last run:</strong> ' + when + ' ' + statusBadge + '</span>' +
            '<span><strong>Strategy:</strong> <code>' + autoEsc(r.strategy_name) + '</code></span>' +
            '<span><strong>Duration:</strong> ' + dur + '</span>' +
            '<span><strong>Signals:</strong> ' + (r.signals_generated != null ? r.signals_generated : '—') + '</span>' +
            '<span><strong>Emails:</strong> ' + (r.emails_sent != null ? r.emails_sent : 0) + ' sent / ' + (r.emails_failed != null ? r.emails_failed : 0) + ' failed</span>';
        if (r.status === 'FAILED' && r.error) {
            el.innerHTML += '<div class="au-error-list" style="width:100%"><strong>Error:</strong> ' + autoEsc(r.error) + '</div>';
        }
        autoSetRunnerStatus(r.status === 'SUCCESS' ? 'success' : r.status === 'FAILED' ? 'error' : 'idle',
                            r.status.toLowerCase());
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
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
        // resolution=eq.1D filter — explicit since migration 43 made market_prices polymorphic.
        // This card describes the equity EOD ingest only; MCX 15-min rows have their own card.
        // Without this filter the "Latest date" would jump to an intraday timestamp once
        // mcx-candles-ingest starts landing rows, making the EOD-staleness signal misleading.
        var countResp = await fetch(
            SUPABASE_URL + '/rest/v1/market_prices?select=id&resolution=eq.1D',
            { headers: wmsHeaders({ 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' }) }
        );
        var contentRange = countResp.headers.get('content-range') || '';
        var totalRows = (contentRange.split('/')[1] || '0').replace(/\D/g, '') || '0';

        // Distinct security count + min/max date — separate small queries for clarity
        var minResp = await fetch(SUPABASE_URL + '/rest/v1/market_prices?select=price_date&resolution=eq.1D&order=price_date.asc&limit=1',
                                  { headers: wmsHeaders() });
        var minRows = await minResp.json();
        var maxResp = await fetch(SUPABASE_URL + '/rest/v1/market_prices?select=price_date&resolution=eq.1D&order=price_date.desc&limit=1',
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
            SUPABASE_URL + '/rest/v1/auto_strategies?select=name,display_name,version,owner,enabled,execution_mode,recipients&order=name',
            { headers: wmsHeaders() }
        );
        var rows = await resp.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<em style="color:#9ca3af">No strategies registered yet.</em>';
            return;
        }
        // Cache for the recipient-editor modal — keep ALL rows (including
        // sentinels) so internal lookups still work.
        window._auStrategiesCache = rows;
        // For display: hide underscore-prefix sentinels (_invalid, _test,
        // _eod_ingest etc) — they're infrastructure rows, not operational.
        var displayRows = rows.filter(function (r) { return r.name && !r.name.startsWith('_'); });
        if (displayRows.length === 0) {
            el.innerHTML = '<em style="color:#9ca3af">No strategies registered yet.</em>';
            return;
        }
        var html = '<div style="width:100%;overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Name</th>' +
                '<th style="padding:6px 8px">Display</th>' +
                '<th style="padding:6px 8px">Version</th>' +
                '<th style="padding:6px 8px">Enabled</th>' +
                '<th style="padding:6px 8px">Mode</th>' +
                '<th style="padding:6px 8px">Recipients</th>' +
                '<th style="padding:6px 8px">Actions</th>' +
                '</tr></thead><tbody>';
        displayRows.forEach(function (r) {
            var recipientsCount = Array.isArray(r.recipients) ? r.recipients.length : 0;
            var recipientsTitle = Array.isArray(r.recipients)
                ? r.recipients.map(function (x) { return (x.name || '') + ' <' + x.email + '>'; }).join(', ')
                : '';
            // Pause/Resume only. Recipient editing intentionally NOT exposed:
            // Resend free tier blocks the whole send if any recipient is
            // unverified, so adding new addresses via UI gives a false UX.
            // Re-enable in Phase 7b once we have per-recipient send-loop
            // OR a verified Resend sending domain. Until then, edit the
            // recipients JSONB via Supabase Studio or DevTools console.
            var actions = '<button class="au-btn au-btn-secondary" style="padding:4px 8px;font-size:11px"' +
                          ' onclick="autoToggleStrategy(' + JSON.stringify(r.name).replace(/"/g, '&quot;') + ',' + r.enabled + ')">' +
                          (r.enabled ? '⏸ Pause' : '▶ Resume') + '</button>';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(r.name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoEsc(r.display_name) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(r.version || '—') + '</td>' +
                    '<td style="padding:6px 8px">' + (r.enabled ? '<span class="au-badge success">yes</span>' : '<span class="au-badge idle">paused</span>') + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(r.execution_mode) + '</td>' +
                    '<td style="padding:6px 8px" title="' + autoEsc(recipientsTitle) + '">' + recipientsCount + '</td>' +
                    '<td style="padding:6px 8px">' + actions + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
    }
}

// ----------------------------------------------------------------------------
// Webhook-driven strategies status (Phase 10b — TV webhook path)
// ----------------------------------------------------------------------------
// Renders one row per strategy whose auto_strategies.metadata.source =
// 'tv_webhook'. Shows: last received signal, today's signal count, last
// heartbeat received, last run status, health badge.
//
// Health logic (uses last_heartbeat_at from auto_strategies.metadata):
//   • during MCX hours (9:00–23:30 IST Mon–Fri):
//       - green: heartbeat ≤ 90 min ago
//       - amber: heartbeat 90–180 min ago
//       - red:   heartbeat > 180 min ago OR never received
//   • outside MCX hours: shown as "off-hours" (no expectations)
// MCX hours are defined here, not in a shared util, because this widget is
// the only consumer; if a second consumer appears, refactor to wms-shared.
// ----------------------------------------------------------------------------

function autoIsWithinMcxHours(now) {
    // Single source of truth = the app-wide MCX window in wms-shared.js
    // (8:55 AM–11:55 PM IST). Used here only for the Webhook Status panel's
    // market-open indicator; price refresh runs through the shared timer.
    if (typeof wmsIsMcxHours === 'function') return wmsIsMcxHours();
    // Fallback if wms-shared.js hasn't loaded: Mon-Fri 9:00 AM–11:55 PM IST.
    var istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
    var ist = new Date(istMs);
    var dow = ist.getUTCDay();       // 0=Sun, 6=Sat (UTC because we shifted)
    if (dow === 0 || dow === 6) return false;
    var minOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return minOfDay >= (9 * 60) && minOfDay <= (23 * 60 + 55);
}

function autoFmtAgo(iso) {
    if (!iso) return { text: 'never', minutesAgo: Infinity };
    var ts = new Date(iso).getTime();
    if (!isFinite(ts)) return { text: 'invalid', minutesAgo: Infinity };
    var minutesAgo = Math.max(0, Math.floor((Date.now() - ts) / 60000));
    var text;
    if (minutesAgo < 1) text = 'just now';
    else if (minutesAgo < 60) text = minutesAgo + ' min ago';
    else if (minutesAgo < 1440) text = Math.floor(minutesAgo / 60) + 'h ' + (minutesAgo % 60) + 'm ago';
    else text = Math.floor(minutesAgo / 1440) + 'd ago';
    return { text: text, minutesAgo: minutesAgo };
}

function autoFmtIstShort(iso) {
    if (!iso) return '—';
    try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '—';
        // Format: "22 May 12:50 IST"
        var istMs = d.getTime() + (5.5 * 60 * 60 * 1000);
        var ist = new Date(istMs);
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var hh = String(ist.getUTCHours()).padStart(2, '0');
        var mm = String(ist.getUTCMinutes()).padStart(2, '0');
        return ist.getUTCDate() + ' ' + months[ist.getUTCMonth()] + ' ' + hh + ':' + mm + ' IST';
    } catch (_) { return '—'; }
}

async function autoLoadWebhookStatus() {
    var el = document.getElementById('au-webhook-status-list');
    var badge = document.getElementById('au-webhook-status-badge');
    if (!el) return;
    el.textContent = 'Loading…';
    if (badge) { badge.textContent = 'loading'; badge.className = 'au-badge idle'; }

    try {
        // 1. Get all webhook-driven strategies.
        // Filter out system sentinels (name starts with '_', e.g. '_invalid' which
        // we keep in the table as an FK placeholder for malformed-JSON deliveries
        // but is not a real operational strategy).
        var stratResp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_strategies?metadata->>source=eq.tv_webhook&select=name,display_name,version,enabled,execution_mode,metadata&order=name',
            { headers: wmsHeaders() }
        );
        var stratsAll = await stratResp.json();
        var strats = Array.isArray(stratsAll)
            ? stratsAll.filter(function (s) { return s.name && !s.name.startsWith('_'); })
            : stratsAll;
        if (!Array.isArray(strats) || strats.length === 0) {
            el.innerHTML = '<em style="color:#9ca3af">No webhook-driven strategies registered. To add one: set <code>metadata.source = "tv_webhook"</code> on the auto_strategies row.</em>';
            if (badge) { badge.textContent = 'empty'; badge.className = 'au-badge idle'; }
            return;
        }

        var inMcx = autoIsWithinMcxHours(new Date());

        // 2. For each strategy, fetch latest webhook signal + today's count + latest run
        var rows = await Promise.all(strats.map(async function (s) {
            var name = s.name;
            // Latest signal
            var sigResp = await fetch(
                SUPABASE_URL + '/rest/v1/auto_signals?strategy_name=eq.' + encodeURIComponent(name) +
                '&source=eq.tv_webhook&select=fired_at,event_type,metadata,email_status' +
                '&order=fired_at.desc&limit=1',
                { headers: wmsHeaders() }
            );
            var sigRows = sigResp.ok ? await sigResp.json() : [];

            // Today's count (rolling 24h)
            var since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            var countResp = await fetch(
                SUPABASE_URL + '/rest/v1/auto_signals?strategy_name=eq.' + encodeURIComponent(name) +
                '&source=eq.tv_webhook&fired_at=gte.' + encodeURIComponent(since) +
                '&select=id',
                { headers: wmsHeaders({ 'Prefer': 'count=exact' }) }
            );
            var todayCount = 0;
            if (countResp.ok) {
                var cr = countResp.headers.get('content-range') || '';
                var m = cr.match(/\/(\d+)$/);
                todayCount = m ? parseInt(m[1], 10) : 0;
            }

            // Latest run
            var runResp = await fetch(
                SUPABASE_URL + '/rest/v1/auto_runs?strategy_name=eq.' + encodeURIComponent(name) +
                '&select=started_at,status,error,metadata&order=started_at.desc&limit=1',
                { headers: wmsHeaders() }
            );
            var runRows = runResp.ok ? await runResp.json() : [];

            return {
                strategy: s,
                latest_signal: sigRows[0] || null,
                today_count: todayCount,
                latest_run: runRows[0] || null,
                last_heartbeat_at: (s.metadata || {}).last_heartbeat_at || null,
            };
        }));

        // 3. Render the table
        var html = '<div style="width:100%;overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Health</th>' +
                '<th style="padding:6px 8px">Last Signal</th>' +
                '<th style="padding:6px 8px">Last 24h</th>' +
                '<th style="padding:6px 8px">Last Heartbeat</th>' +
                '<th style="padding:6px 8px">Last Run</th>' +
                '</tr></thead><tbody>';

        var worstHealth = 'green';   // overall badge
        rows.forEach(function (r) {
            var hb = autoFmtAgo(r.last_heartbeat_at);
            var health = 'off-hours';
            var healthBadge = '<span class="au-badge idle" title="MCX market closed — no heartbeat expected">🌙 off-hours</span>';
            if (inMcx) {
                if (r.last_heartbeat_at == null) {
                    health = 'red';
                    healthBadge = '<span class="au-badge error" title="No heartbeat ever received">🔴 silent</span>';
                } else if (hb.minutesAgo <= 90) {
                    health = 'green';
                    healthBadge = '<span class="au-badge success" title="Heartbeat fresh (≤90 min)">🟢 healthy</span>';
                } else if (hb.minutesAgo <= 180) {
                    health = 'amber';
                    healthBadge = '<span class="au-badge warning" title="Heartbeat aging (90–180 min)">🟡 stale</span>';
                } else {
                    health = 'red';
                    healthBadge = '<span class="au-badge error" title="Heartbeat overdue (>180 min)">🔴 silent</span>';
                }
            }
            if (health === 'red')   worstHealth = 'red';
            else if (health === 'amber' && worstHealth !== 'red') worstHealth = 'amber';

            var sig = r.latest_signal;
            var sigCell = sig
                ? autoFmtIstShort(sig.fired_at) + ' · <code>' + autoEsc(sig.event_type || '—') + '</code> · email <code>' + autoEsc(sig.email_status || '—') + '</code>'
                : '<em style="color:#9ca3af">none yet</em>';

            var run = r.latest_run;
            var runCell;
            if (!run) {
                runCell = '<em style="color:#9ca3af">none yet</em>';
            } else {
                var runBadge = run.status === 'SUCCESS'
                    ? '<span class="au-badge success">SUCCESS</span>'
                    : '<span class="au-badge error" title="' + autoEsc(run.error || '') + '">FAILED</span>';
                var runDeduped = (run.metadata || {}).deduped ? ' <span class="au-badge idle" title="duplicate dedupe_key — no DB write">deduped</span>' : '';
                runCell = autoFmtIstShort(run.started_at) + ' · ' + runBadge + runDeduped;
            }

            html += '<tr style="border-top:1px solid #e5e7eb;vertical-align:top">' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(r.strategy.name) + '</code><br><span style="color:#6b7280;font-size:11px">' + autoEsc(r.strategy.display_name) + '</span></td>' +
                    '<td style="padding:6px 8px">' + healthBadge + '</td>' +
                    '<td style="padding:6px 8px">' + sigCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right"><b>' + r.today_count + '</b></td>' +
                    '<td style="padding:6px 8px">' + (r.last_heartbeat_at ? autoFmtIstShort(r.last_heartbeat_at) + ' <span style="color:#6b7280">(' + autoEsc(hb.text) + ')</span>' : '<em style="color:#9ca3af">never</em>') + '</td>' +
                    '<td style="padding:6px 8px">' + runCell + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        html += '<div class="au-meta" style="margin-top:8px;font-size:11px;color:#6b7280">Health based on last heartbeat age during MCX hours (9:00–23:30 IST Mon–Fri). "Last 24h" is a rolling count over the past 24 hours.</div>';

        el.innerHTML = html;
        if (badge) {
            if (!inMcx) { badge.textContent = 'off-hours'; badge.className = 'au-badge idle'; }
            else if (worstHealth === 'red') { badge.textContent = 'alert'; badge.className = 'au-badge error'; }
            else if (worstHealth === 'amber') { badge.textContent = 'stale'; badge.className = 'au-badge warning'; }
            else { badge.textContent = 'healthy'; badge.className = 'au-badge success'; }
        }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load webhook status: ' + autoEsc(String(e)) + '</span>';
        if (badge) { badge.textContent = 'error'; badge.className = 'au-badge error'; }
    }
}

// ----------------------------------------------------------------------------
// Strategy write actions (Phase 7a)
// ----------------------------------------------------------------------------

async function autoToggleStrategy(name, currentlyEnabled) {
    var verb = currentlyEnabled ? 'Pause' : 'Resume';
    var consequence = currentlyEnabled
        ? 'No new scans will run for "' + name + '" until you Resume it. Open trades are NOT auto-managed while paused (no exit checks).'
        : 'Strategy "' + name + '" will resume scanning at the next cron tick (next: every weekday at 9:30 / 11:30 / 13:30 / 15:15 IST).';
    if (!confirm(verb + ' strategy "' + name + '"?\n\n' + consequence)) return;
    try {
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(name),
            { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
              body: JSON.stringify({ enabled: !currentlyEnabled }) }
        );
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        autoLoadStrategies();
    } catch (e) {
        alert('Failed to update: ' + (e.message || e));
    }
}

function autoOpenRecipientsModal(name) {
    var strat = (window._auStrategiesCache || []).find(function (s) { return s.name === name; });
    if (!strat) { alert('Strategy "' + name + '" not loaded — refresh the strategies list.'); return; }
    var rcpts = Array.isArray(strat.recipients) ? strat.recipients.slice() : [];
    // Render modal
    var modal = document.getElementById('au-recipients-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'au-recipients-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center';
        document.body.appendChild(modal);
    }
    modal.innerHTML =
        '<div style="background:#fff;border-radius:8px;max-width:560px;width:90%;padding:20px;box-shadow:0 8px 24px rgba(0,0,0,0.18)">' +
            '<h3 style="margin:0 0 4px;font-size:15px;color:#1f2937">Recipients for <code>' + autoEsc(name) + '</code></h3>' +
            '<p style="margin:0 0 12px;font-size:12px;color:#6b7280">Anyone listed here gets the strategy\'s alert email on every signal. ' +
            'The first email must match a Resend-verified address (currently <code>vikash.bagla@gmail.com</code>); additional recipients should be handled via Gmail forwards or domain verification.</p>' +
            '<div id="au-recipients-rows"></div>' +
            '<div style="margin-top:8px"><button class="au-btn au-btn-secondary" onclick="autoAddRecipientRow()">+ Add recipient</button></div>' +
            '<div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end">' +
                '<button class="au-btn au-btn-secondary" onclick="autoCloseRecipientsModal()">Cancel</button>' +
                '<button class="au-btn au-btn-primary" onclick="autoSaveRecipients(' + JSON.stringify(name).replace(/"/g, '&quot;') + ')">Save</button>' +
            '</div>' +
        '</div>';
    autoRenderRecipientsRows(rcpts);
}

function autoCloseRecipientsModal() {
    var modal = document.getElementById('au-recipients-modal');
    if (modal) modal.remove();
}

function autoRenderRecipientsRows(arr) {
    var box = document.getElementById('au-recipients-rows');
    if (!box) return;
    if (arr.length === 0) { box.innerHTML = '<div style="font-size:12px;color:#9ca3af;padding:8px 0">No recipients — add at least one.</div>'; return; }
    var html = '';
    arr.forEach(function (r, i) {
        html += '<div class="au-rcpt-row" style="display:flex;gap:6px;margin-bottom:6px;align-items:center">' +
                '<input class="au-rcpt-name"  data-i="' + i + '" placeholder="Name"  value="' + autoEsc(r.name || '') + '" style="flex:1;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:12px">' +
                '<input class="au-rcpt-email" data-i="' + i + '" placeholder="email" value="' + autoEsc(r.email || '') + '" style="flex:2;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:12px">' +
                '<button class="au-btn au-btn-danger" style="padding:4px 10px;font-size:11px" onclick="autoRemoveRecipientRow(' + i + ')">×</button>' +
                '</div>';
    });
    box.innerHTML = html;
    box.dataset.rcpts = JSON.stringify(arr);
}

function autoCollectRecipientsFromForm() {
    var rows = document.querySelectorAll('#au-recipients-rows .au-rcpt-row');
    var arr = [];
    rows.forEach(function (row) {
        var name  = (row.querySelector('.au-rcpt-name')  || {}).value || '';
        var email = (row.querySelector('.au-rcpt-email') || {}).value || '';
        arr.push({ name: name.trim(), email: email.trim() });
    });
    return arr;
}

function autoAddRecipientRow() {
    var current = autoCollectRecipientsFromForm();
    current.push({ name: '', email: '' });
    autoRenderRecipientsRows(current);
}

function autoRemoveRecipientRow(i) {
    var current = autoCollectRecipientsFromForm();
    current.splice(i, 1);
    autoRenderRecipientsRows(current);
}

async function autoSaveRecipients(name) {
    var rcpts = autoCollectRecipientsFromForm().filter(function (r) { return r.email; });
    // Basic email shape validation
    var bad = rcpts.find(function (r) { return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email); });
    if (bad) { alert('Invalid email: ' + bad.email); return; }
    if (rcpts.length === 0) {
        if (!confirm('No recipients — emails will not be sent for any future signal. Continue?')) return;
    }
    try {
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_strategies?name=eq.' + encodeURIComponent(name),
            { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
              body: JSON.stringify({ recipients: rcpts }) }
        );
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        autoCloseRecipientsModal();
        autoLoadStrategies();
    } catch (e) {
        alert('Failed to save: ' + (e.message || e));
    }
}

// ----------------------------------------------------------------------------
// Manual close (Phase 7a)
// ----------------------------------------------------------------------------
//
// v_auto_open_trades closes a trade when net qty per symbol == 0. So a manual
// close is just a signal row whose legs are the reverse-side of the ENTRY's
// legs, same qty. event_type='MANUAL_CLOSE' for audit trail; email_status set
// to PENDING but no email actually sent — chassis is the only thing that calls
// Resend, and we skip that here. Operator already knows they closed it.

async function autoManualClose(tradeId) {
    if (!tradeId) return;
    // Pull the ENTRY signal for this trade to get the legs
    var entryResp = await fetch(
        SUPABASE_URL + '/rest/v1/auto_signals?trade_id=eq.' + encodeURIComponent(tradeId) + '&event_type=eq.ENTRY&select=*',
        { headers: wmsHeaders() }
    );
    var entries = await entryResp.json();
    if (!Array.isArray(entries) || entries.length === 0) {
        alert('Could not find ENTRY signal for trade ' + tradeId.slice(0, 8));
        return;
    }
    var entry = entries[0];
    var pair = (entry.metadata && entry.metadata.Pair) || '(unknown pair)';
    var prompt = 'Manually close ' + pair + '?\n\n' +
                 'This inserts a CLOSE signal with reversed legs at entry prices. The trade will disappear from Open Trades immediately. ' +
                 'NO email is sent. P&L will be computed against actual market close prices in the Performance dashboard (Phase 8).\n\n' +
                 'Trade: ' + tradeId.slice(0, 8) + '…';
    if (!confirm(prompt)) return;

    var closeLegs = (entry.legs || []).map(function (leg) {
        return Object.assign({}, leg, { side: leg.side === 'BUY' ? 'SELL' : 'BUY' });
    });
    var payload = {
        trade_id: tradeId,
        strategy_name: entry.strategy_name,
        execution_mode: entry.execution_mode || 'PAPER',
        event_type: 'MANUAL_CLOSE',
        direction: 'CLOSE',
        score: 0,
        legs: closeLegs,
        metadata: {
            Pair: pair,
            exit_reason: 'manual close by operator',
            manual_override: true,
            entry_signal_id: entry.id,
        },
        notes: 'Manually closed by operator at ' + new Date().toISOString(),
        email_status: 'SKIPPED',
        email_subject: null,
        email_recipients: null,
    };

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/auto_signals', {
            method: 'POST',
            headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
            body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        autoLoadOpenTrades();
        // Also refresh events tab if it's been visited
        if (window._auEventsLoaded) autoLoadEvents(window._auEventsFilter || 'all');
    } catch (e) {
        alert('Failed to close: ' + (e.message || e));
    }
}

// ----------------------------------------------------------------------------
// IST timestamp formatter — used everywhere a fired_at / started_at is shown.
// ----------------------------------------------------------------------------

// dd-mmm-yy hh:mm in IST. Compact for tight columns.
// e.g. "03-Jun-26 14:21"
function autoFmtIST(iso) {
    if (!iso) return '—';
    try {
        var d = new Date(iso);
        // Add +5:30 to UTC to get IST, then read UTC parts
        var ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var dd = String(ist.getUTCDate()).padStart(2, '0');
        var mm = months[ist.getUTCMonth()];
        var yy = String(ist.getUTCFullYear()).slice(2);
        var hh = String(ist.getUTCHours()).padStart(2, '0');
        var min = String(ist.getUTCMinutes()).padStart(2, '0');
        return dd + '-' + mm + '-' + yy + ' ' + hh + ':' + min;
    } catch (_e) { return iso; }
}

// Pretty-format a futures contract symbol for display.
// Strips the MCX: prefix and reconstructs as "SILVERM 30 Jun 26 Fut"
// using the expiry_date field instead of the symbol's embedded month code.
// e.g. ("MCX:SILVERM26JUNFUT", "2026-06-30") → "SILVERM 30 Jun 26 Fut"
function autoFmtContract(symbol, expiry_date) {
    if (!symbol) return '—';
    var short = symbol.replace(/^MCX:/, '');
    // If no expiry_date provided, return the bare short (e.g. SILVERM26JUNFUT)
    if (!expiry_date) return short;
    // Extract the underlying (strip trailing "26JUNFUT" / "26JUL FUT" etc)
    var underlying = short.replace(/\d+[A-Z]+FUT$/, '');
    try {
        var d = new Date(expiry_date);
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var dd = String(d.getUTCDate()).padStart(2, '0');
        var mm = months[d.getUTCMonth()];
        var yy = String(d.getUTCFullYear()).slice(2);
        return underlying + ' ' + dd + ' ' + mm + ' ' + yy + ' Fut';
    } catch (_e) {
        return underlying || short;
    }
}

// Indian-format integer rupee (zero decimals). e.g. 271955 → "2,71,955"
function autoFmtPrice0(n) {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(Number(n)).toLocaleString('en-IN');
}

function autoFmtDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
}

function autoStatusBadge(status) {
    if (status === 'SUCCESS')  return '<span class="au-badge success">success</span>';
    if (status === 'FAILED')   return '<span class="au-badge error">failed</span>';
    if (status === 'RUNNING')  return '<span class="au-badge loading">running</span>';
    return '<span class="au-badge idle">' + autoEsc(String(status || '—').toLowerCase()) + '</span>';
}

// ----------------------------------------------------------------------------
// Open Trades tab
// ----------------------------------------------------------------------------
//
// v_auto_open_trades is sparse (trade_id, strategy_name, net_position). To
// give the user something useful, we join client-side to auto_signals to fetch
// the ENTRY row for each open trade — that carries the metadata (Pair, Z90,
// Score, Action, Z_Target, Z_Stop, qtys, etc).
//
// Live P&L mark: pull latest close per symbol from market_prices; compute
// P&L per leg = (mark - entry_price) * qty for BUY, flipped for SELL; sum
// across legs. Mark is yesterday's close during trading hours, today's after
// eod-prices-ingest runs at 18:00 IST. Tooltip shows the mark date.

async function autoFetchLatestPrices(sigRows) {
    // Marks for live P&L. Live LTP comes from the shared price cache
    // (wmsLivePrices, populated by the single app-wide wmsStandardRefresh) — no
    // direct Fyers call. Returns { SHORT_SYMBOL: { close, date } } with
    // date='live' for cache hits; falls back to the latest market_prices close
    // for any symbol not in the cache. (WMS-LESSONS §E.11.10)
    var shortToFyers = {};
    sigRows.forEach(function (s) {
        (s.legs || []).forEach(function (l) {
            if (l.symbol && l.short_symbol) shortToFyers[l.short_symbol] = l.symbol;
        });
    });
    var result = {};
    var shorts = Object.keys(shortToFyers);
    if (shorts.length === 0) return result;

    // Register pairs symbols with the shared refresh list so the app-wide timer
    // fetches them; warm the cache once if anything is still missing.
    _auPairsSyms = shorts.map(function (ss) { return { fyersKey: shortToFyers[ss], cacheKey: ss }; });
    if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
    if (typeof wmsStandardRefresh === 'function' && window.fyersToken) {
        var cold = shorts.some(function (ss) { var r = (window.wmsLivePrices || {})[ss]; return !(r && r.lp > 0); });
        if (cold) { try { await wmsStandardRefresh(true); } catch (_e) {} }
    }
    var cache = window.wmsLivePrices || {};
    shorts.forEach(function (ss) {
        var fk = shortToFyers[ss];
        var bare = fk.replace(/^[A-Z]+:/, '').replace(/-(EQ|BE|BZ|BL|SM|ST)$/i, '');
        var rec = cache[ss] || cache[fk] || cache[bare];
        if (rec && Number.isFinite(rec.lp) && rec.lp > 0) result[ss] = { close: rec.lp, date: 'live' };
    });
    if (Object.keys(result).length === shorts.length) return result;

    // Fallback: latest close from market_prices for any symbols not in the cache
    try {
        var missing = Object.keys(shortToFyers).filter(function (s) { return !result[s]; });
        if (missing.length === 0) return result;
        var symList = missing.map(encodeURIComponent).join(',');
        var secResp = await fetch(
            SUPABASE_URL + '/rest/v1/securities_db?symbol=in.(' + symList + ')&select=id,symbol',
            { headers: wmsHeaders() }
        );
        var secs = await secResp.json();
        if (!Array.isArray(secs) || secs.length === 0) return result;
        var idToSym = {};
        var secIds = secs.map(function (r) { idToSym[r.id] = r.symbol; return r.id; });
        var cutoff = new Date(Date.now() - 10 * 86400 * 1000).toISOString().slice(0, 10);
        var idsList = secIds.map(encodeURIComponent).join(',');
        var priceResp = await fetch(
            SUPABASE_URL + '/rest/v1/market_prices?security_id=in.(' + idsList + ')&resolution=eq.1D&price_date=gte.' + cutoff + '&select=security_id,price_date,close&order=price_date.desc',
            { headers: wmsHeaders() }
        );
        var prices = await priceResp.json();
        prices.forEach(function (p) {
            var sym = idToSym[p.security_id];
            if (!sym || result[sym]) return;
            if (!result[sym] || p.price_date > result[sym].date) {
                result[sym] = { close: p.close, date: p.price_date };
            }
        });
    } catch (_e) { /* keep whatever Fyers returned */ }
    return result;
}

function autoComputePnL(legs, priceMap) {
    if (!Array.isArray(legs) || legs.length === 0) return null;
    var total = 0;
    var anyPriced = false;
    var legBreakdown = [];
    var markDate = null;
    legs.forEach(function (l) {
        var mark = priceMap[l.short_symbol];
        if (!mark || !Number.isFinite(mark.close)) {
            legBreakdown.push(l.short_symbol + ': mark unavailable');
            return;
        }
        anyPriced = true;
        if (!markDate || mark.date < markDate) markDate = mark.date; // oldest mark wins (worst case freshness)
        var legPnL = (l.side === 'BUY')
            ? (mark.close - l.price) * l.qty
            : (l.price - mark.close) * l.qty;
        total += legPnL;
        legBreakdown.push(l.short_symbol + ' ' + l.side + ' ' + l.qty + ' @ entry ₹' + l.price + ' / mark ₹' + mark.close + ' = ' + (legPnL >= 0 ? '+' : '') + Math.round(legPnL));
    });
    if (!anyPriced) return null;
    return { total: total, breakdown: legBreakdown.join(' • '), markDate: markDate };
}

// Returns a Set of strategy names whose auto_strategies.metadata.source === 'tv_webhook'.
// Cached on window after first call. The GS Open/Closed Trades cards handle these
// strategies; the Pairs Open/Closed cards exclude them.
// System sentinels (name starts with '_', e.g. '_invalid') are filtered out — they
// are infrastructure rows, not real strategies.
async function autoGetWebhookStrategyNames() {
    if (window._auWebhookStrategyNames instanceof Set) return window._auWebhookStrategyNames;
    try {
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_strategies?metadata->>source=eq.tv_webhook&select=name',
            { headers: wmsHeaders() }
        );
        var rows = await resp.json();
        var set = new Set((rows || [])
            .filter(function (r) { return r.name && !r.name.startsWith('_'); })
            .map(function (r) { return r.name; }));
        window._auWebhookStrategyNames = set;
        return set;
    } catch (_e) { return new Set(); }
}

async function autoLoadOpenTrades(silent) {
    var el = document.getElementById('au-open-trades-content');
    var statusEl = document.getElementById('au-open-trades-status');
    if (!el) return;
    if (!silent) {
        if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
        // Keep the existing table on screen during silent shared-refresh cycles
        // for flicker-free updates; only show the spinner on a user-initiated load.
        if (!el.firstElementChild || !el.querySelector('table')) {
            el.innerHTML = '<div class="au-meta">⏳ Loading open trades…</div>';
        }
    }

    try {
        // 1) Get list of open trade_ids from the view, filter out webhook strategies
        var webhookStrats = await autoGetWebhookStrategyNames();
        var openResp = await fetch(
            SUPABASE_URL + '/rest/v1/v_auto_open_trades?select=*',
            { headers: wmsHeaders() }
        );
        var openRowsAll = await openResp.json();
        var openRows = (openRowsAll || []).filter(function (r) { return !webhookStrats.has(r.strategy_name); });
        if (!Array.isArray(openRows) || openRows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No open pairs trades.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 open'; }
            return;
        }

        // 2) Fetch ENTRY signals for those trade_ids
        var tradeIds = openRows.map(function (r) { return r.trade_id; });
        var idsList = tradeIds.map(encodeURIComponent).join(',');
        var sigResp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_signals?event_type=eq.ENTRY&trade_id=in.(' + idsList + ')&select=trade_id,fired_at,score,direction,legs,metadata,strategy_name',
            { headers: wmsHeaders() }
        );
        var sigRows = await sigResp.json();
        var byTrade = {};
        sigRows.forEach(function (s) { byTrade[s.trade_id] = s; });

        // 3) Fetch latest close per symbol from market_prices for live P&L mark.
        //    During trading hours this is yesterday's close; after eod-prices-ingest
        //    runs (18:00 IST) it'll be today's close. Tooltip shows the mark date.
        var priceMap = await autoFetchLatestPrices(sigRows);

        var now = Date.now();
        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Pair</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Action</th>' +
                '<th style="padding:6px 8px">Entry</th>' +
                '<th style="padding:6px 8px">Days</th>' +
                '<th style="padding:6px 8px">Entry Z90</th>' +
                '<th style="padding:6px 8px">Z<sub>tgt</sub> / Z<sub>stop</sub></th>' +
                '<th style="padding:6px 8px">Score</th>' +
                '<th style="padding:6px 8px">P&amp;L</th>' +
                '<th style="padding:6px 8px">Net Position</th>' +
                '<th style="padding:6px 8px">Trade</th>' +
                '<th style="padding:6px 8px">Action</th>' +
                '</tr></thead><tbody>';
        openRows.forEach(function (ot) {
            var sig = byTrade[ot.trade_id];
            var m = (sig && sig.metadata) || {};
            var pair = m.Pair || '—';
            var action = m.Action || (sig ? sig.direction : '—');
            var entry = sig ? autoFmtIST(sig.fired_at) : '—';
            var daysHeld = sig ? Math.floor((now - new Date(sig.fired_at).getTime()) / 86400000) : '—';
            var entryZ = m.Z90 != null ? m.Z90 : '—';
            var zTgt = m.Z_Target != null ? m.Z_Target : '—';
            var zStop = m.Z_Stop != null ? m.Z_Stop : '—';
            var score = sig ? (sig.score + '/' + (m.Score_Max || 13)) : '—';
            // net_position is a JSONB object — render as compact string
            var netPos = ot.net_position ? Object.keys(ot.net_position).map(function (k) {
                var v = ot.net_position[k];
                return (v > 0 ? '+' : '') + v + ' ' + k.replace('NSE:', '').replace('-EQ', '');
            }).join(' / ') : '—';
            var tradeFrag = ot.trade_id ? ot.trade_id.slice(0, 8) + '…' : '—';

            // Live P&L — computed against latest market_prices close
            var pnlCell = '<span style="color:#9ca3af">—</span>';
            var pnlTooltip = 'Mark prices not available — was the EOD ingest run today?';
            var pnl = sig ? autoComputePnL(sig.legs, priceMap) : null;
            if (pnl) {
                var sign = pnl.total >= 0 ? '+' : '−';
                var color = pnl.total >= 0 ? '#047857' : '#dc2626';
                var abs = Math.abs(Math.round(pnl.total)).toLocaleString('en-IN');
                pnlCell = '<span style="color:' + color + ';font-weight:600">' + sign + '₹' + abs + '</span>';
                pnlTooltip = 'Mark date: ' + pnl.markDate + ' • ' + pnl.breakdown;
            }
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><strong>' + autoEsc(pair) + '</strong></td>' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(ot.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoEsc(action) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(entry) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(String(daysHeld)) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(String(entryZ)) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(String(zTgt)) + ' / ' + autoEsc(String(zStop)) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(score) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;white-space:nowrap" title="' + autoEsc(pnlTooltip) + '">' + pnlCell + '</td>' +
                    '<td style="padding:6px 8px;font-size:11px">' + autoEsc(netPos) + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:11px">' + autoEsc(tradeFrag) + '</td>' +
                    '<td style="padding:6px 8px"><button class="au-btn au-btn-danger" style="padding:4px 8px;font-size:11px"' +
                        ' onclick="autoManualClose(' + JSON.stringify(ot.trade_id).replace(/"/g, '&quot;') + ')">✕ Close</button></td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = openRows.length + ' open'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----------------------------------------------------------------------------
// Closed Trades block (sibling card on the Open Trades tab)
// ----------------------------------------------------------------------------
//
// There is no auto_trades table — every trade is a `trade_id` UUID shared
// across `auto_signals` events (ENTRY → TARGET_HIT / STOP_HIT / TIME_STOP /
// MANUAL_CLOSE). The `v_auto_open_trades` SQL view derives openness by
// summing legs across signals and keeping trade_ids where some leg has
// non-zero net qty.
//
// "Closed" is the inverse: trade_ids where ALL legs net to zero. Rather
// than adding a mirror SQL view (Option B in the design discussion), we
// derive this client-side from the same `legs` JSON the open view uses —
// no DB migration, same source data, can't disagree with the open view
// because both consume the same events.
//
// Realised P&L = Σ legs across all events of (side === 'SELL' ? +1 : −1)
// × price × qty. For a fully-closed trade this is the actual cash settled.

var _AU_CLOSED_LIMIT = 500;  // Recent events window — covers everything since PAPER launch

function _autoExitTypeLabel(t) {
    if (!t) return '—';
    return t.replace(/_/g, ' ');  // TARGET_HIT → "TARGET HIT"
}

function _autoExitTypeColor(t) {
    return t === 'TARGET_HIT' ? '#0891b2' :
           t === 'STOP_HIT'   ? '#dc2626' :
           t === 'TIME_STOP'  ? '#92400e' :
           t === 'MANUAL_CLOSE' ? '#7c3aed' : '#6b7280';
}

async function autoLoadClosedTrades() {
    var el = document.getElementById('au-closed-trades-content');
    var statusEl = document.getElementById('au-closed-trades-status');
    var footEl = document.getElementById('au-closed-trades-footnote');
    if (!el) return;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
    el.innerHTML = '<div class="au-meta">⏳ Loading closed trades…</div>';
    if (footEl) footEl.textContent = '';

    try {
        // Get set of webhook strategy names to exclude (handled by GS Closed card)
        var webhookStrats = await autoGetWebhookStrategyNames();
        // Fetch recent events. The window covers everything since the module
        // went live (29-Apr-2026); revisit pagination if/when the event log
        // grows past 500. Order desc so we naturally see the most recent
        // first and footnote the scope cleanly.
        var resp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_signals?order=fired_at.desc&limit=' + _AU_CLOSED_LIMIT +
            '&select=id,trade_id,strategy_name,fired_at,event_type,direction,score,legs,metadata',
            { headers: wmsHeaders() }
        );
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
        var allSignals = await resp.json();
        if (!Array.isArray(allSignals)) allSignals = [];

        // Group by trade_id
        var byTrade = {};
        allSignals.forEach(function (s) {
            if (!s.trade_id) return;
            if (!byTrade[s.trade_id]) byTrade[s.trade_id] = [];
            byTrade[s.trade_id].push(s);
        });

        // For each group: compute per-symbol net qty + realised P&L. Closed
        // iff every symbol nets to exactly zero AND there is ≥1 non-ENTRY
        // event. Trades that have only the ENTRY in our window are obviously
        // not closed.
        var closedRows = [];
        Object.keys(byTrade).forEach(function (tradeId) {
            var events = byTrade[tradeId];
            var hasExitEvent = false;
            var netBySym = {};
            var pnl = 0;
            events.forEach(function (s) {
                if (s.event_type !== 'ENTRY') hasExitEvent = true;
                (s.legs || []).forEach(function (l) {
                    var sym = l.short_symbol || l.symbol || '';
                    if (!sym) return;
                    var q = Number(l.qty) || 0;
                    var p = Number(l.price) || 0;
                    if ((l.side || '').toUpperCase() === 'BUY') {
                        netBySym[sym] = (netBySym[sym] || 0) + q;
                        pnl -= p * q;
                    } else if ((l.side || '').toUpperCase() === 'SELL') {
                        netBySym[sym] = (netBySym[sym] || 0) - q;
                        pnl += p * q;
                    }
                });
            });
            if (!hasExitEvent) return;
            // All symbols must net to zero (tolerate float dust from numeric storage)
            var allZero = Object.keys(netBySym).every(function (k) {
                return Math.abs(netBySym[k]) < 1e-6;
            });
            if (!allZero) return;

            // Pick the ENTRY event (oldest within the trade) and the closing
            // event (most recent non-ENTRY)
            var entry = null, exit = null;
            events.forEach(function (s) {
                if (s.event_type === 'ENTRY') {
                    if (!entry || s.fired_at < entry.fired_at) entry = s;
                } else {
                    if (!exit || s.fired_at > exit.fired_at) exit = s;
                }
            });
            if (!entry) return;  // edge case — no ENTRY in our window (window too narrow)

            // Skip webhook-driven strategies — they have their own GS Closed card
            if (webhookStrats.has(entry.strategy_name)) return;
            closedRows.push({
                trade_id: tradeId,
                strategy_name: entry.strategy_name,
                entry: entry,
                exit: exit,
                pnl: pnl
            });
        });

        // Sort: most recently closed first
        closedRows.sort(function (a, b) {
            var aT = a.exit ? a.exit.fired_at : a.entry.fired_at;
            var bT = b.exit ? b.exit.fired_at : b.entry.fired_at;
            return bT < aT ? -1 : bT > aT ? 1 : 0;
        });

        if (closedRows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No closed trades in the last ' + _AU_CLOSED_LIMIT + ' events.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 closed'; }
            if (footEl) footEl.textContent = 'Scope: most recent ' + allSignals.length + ' events (max ' + _AU_CLOSED_LIMIT + ').';
            return;
        }

        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Pair</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Action</th>' +
                '<th style="padding:6px 8px">Entry</th>' +
                '<th style="padding:6px 8px">Exit</th>' +
                '<th style="padding:6px 8px">Days</th>' +
                '<th style="padding:6px 8px">Entry Z90</th>' +
                '<th style="padding:6px 8px">Exit Reason</th>' +
                '<th style="padding:6px 8px;text-align:right">Realised P&amp;L</th>' +
                '<th style="padding:6px 8px">Trade</th>' +
                '</tr></thead><tbody>';

        var totalPnL = 0, winCount = 0, lossCount = 0;
        closedRows.forEach(function (ct) {
            var em = (ct.entry && ct.entry.metadata) || {};
            var pair = em.Pair || '—';
            var action = em.Action || (ct.entry ? ct.entry.direction : '—');
            var entryStr = ct.entry ? autoFmtIST(ct.entry.fired_at) : '—';
            var exitStr = ct.exit ? autoFmtIST(ct.exit.fired_at) : '—';
            var daysHeld = (ct.entry && ct.exit) ? Math.max(0, Math.floor((new Date(ct.exit.fired_at).getTime() - new Date(ct.entry.fired_at).getTime()) / 86400000)) : '—';
            var entryZ = em.Z90 != null ? em.Z90 : '—';
            var exitType = ct.exit ? ct.exit.event_type : '—';
            var exitTypeColor = _autoExitTypeColor(exitType);

            var pnl = ct.pnl;
            totalPnL += pnl;
            if (pnl >= 0) winCount++; else lossCount++;
            var pnlSign = pnl >= 0 ? '+' : '−';
            var pnlColor = pnl >= 0 ? '#047857' : '#dc2626';
            var pnlAbs = Math.abs(Math.round(pnl)).toLocaleString('en-IN');
            var pnlCell = '<span style="color:' + pnlColor + ';font-weight:600">' + pnlSign + '₹' + pnlAbs + '</span>';

            var tradeFrag = ct.trade_id ? ct.trade_id.slice(0, 8) + '…' : '—';

            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px"><strong>' + autoEsc(pair) + '</strong></td>' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(ct.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoEsc(action) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(entryStr) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(exitStr) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(String(daysHeld)) + '</td>' +
                    '<td style="padding:6px 8px">' + autoEsc(String(entryZ)) + '</td>' +
                    '<td style="padding:6px 8px"><span style="color:' + exitTypeColor + ';font-weight:600">' + autoEsc(_autoExitTypeLabel(exitType)) + '</span></td>' +
                    '<td style="padding:6px 8px;text-align:right;white-space:nowrap">' + pnlCell + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:11px">' + autoEsc(tradeFrag) + '</td>' +
                    '</tr>';
        });

        // Summary footer row
        var totalSign = totalPnL >= 0 ? '+' : '−';
        var totalColor = totalPnL >= 0 ? '#047857' : '#dc2626';
        var totalAbs = Math.abs(Math.round(totalPnL)).toLocaleString('en-IN');
        html += '<tfoot><tr style="border-top:2px solid #cbd5e0;background:#f7fafc;font-weight:700">' +
                '<td colspan="8" style="padding:8px">Total (' + closedRows.length + ' closed' +
                (winCount + lossCount > 0 ? ' — ' + winCount + 'W / ' + lossCount + 'L' : '') + ')</td>' +
                '<td style="padding:8px;text-align:right;color:' + totalColor + '">' + totalSign + '₹' + totalAbs + '</td>' +
                '<td style="padding:8px">—</td>' +
                '</tr></tfoot>';

        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = closedRows.length + ' closed'; }
        if (footEl) footEl.textContent = 'Scope: most recent ' + allSignals.length + ' events (max ' + _AU_CLOSED_LIMIT + '). Trades whose ENTRY falls outside this window won\'t appear.';
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----------------------------------------------------------------------------
// GS Open + Closed Trades cards (TV webhook driven — single-instrument MS007)
// ----------------------------------------------------------------------------
//
// These cards mirror the structure of autoLoadOpenTrades / autoLoadClosedTrades
// but render fields specific to single-instrument futures strategies (Silver
// Mini, Gold Mini): entry/stop/ATR/contract/qty + live P&L computed against
// the current Fyers LTP for the executed front-month symbol.
//
// Live P&L formula:
//   side_sign × (ltp − entry_price) × qty_lots × point_value
//   where side_sign = +1 for LONG, −1 for SHORT.
//
// Point values are intrinsic to the underlying contract spec (₹ profit per ₹1
// price move per lot). Source of truth = gs_catalogue.ts on the server; we
// duplicate the values here for browser use. Add new entries when a new GS
// instrument is added to gs_catalogue.

var AU_GS_POINT_VALUES = {
    SILVERM: 5.0,
    GOLDM:   10.0,
    // Add more when needed; trades for instruments not listed show P&L as "—".
};

// Physical lot size for display (so "5 lots" can be enriched as "= 25 kg").
// SILVERM: 1 lot = 5 kg of silver.
// GOLDM:   1 lot = 100 g of gold (= 10 × 10g quotation unit).
var AU_GS_PHYSICAL_LOT = {
    SILVERM: { qty: 5,   unit: 'kg' },
    GOLDM:   { qty: 100, unit: 'g'  },
};

// Margin requirement as % of notional exposure (Fyers SPAN + exposure, rounded
// up to a conservative buffer). Confirmed against Fyers margin calculator
// 2026-06-02: SILVERM 1 lot @ ~₹13.65L exposure → ~₹2.55L margin (18.7%, round
// to 20). GOLDM 1 lot @ ~₹15.80L exposure → ~₹1.45L margin (9.2%, round to 10).
// Update when broker margin rules change.
var AU_GS_MARGIN_PCT = {
    SILVERM: 20,
    GOLDM:   10,
};

function autoGsPointValue(shortSymbol) {
    return AU_GS_POINT_VALUES[shortSymbol] || null;
}

function autoGsPhysicalLot(shortSymbol) {
    return AU_GS_PHYSICAL_LOT[shortSymbol] || null;
}

function autoGsMarginPct(shortSymbol) {
    return AU_GS_MARGIN_PCT[shortSymbol] || null;
}

// Read current LTP for a list of full Fyers symbols from the shared price cache
// `wmsLivePrices` (populated by the single app-wide wmsStandardRefresh). Returns
// Map<symbol, ltp>. No direct Fyers call — the shared timer owns all fetching.
// (WMS-LESSONS §E.11.10)
function autoFetchLtpForSymbols(symbols) {
    var out = new Map();
    if (!symbols || symbols.length === 0) return out;
    var cache = window.wmsLivePrices || {};
    symbols.forEach(function (sym) {
        if (!sym) return;
        var bare = sym.replace(/^[A-Z]+:/, '');
        var rec = cache[sym] || cache[bare];
        if (rec && typeof rec.lp === 'number' && rec.lp > 0) out.set(sym, rec.lp);
    });
    return out;
}

// Compute live P&L for one GS trade. Returns { pnl, breakdown } or null if
// we can't compute (missing LTP or unknown point_value).
function autoGsComputeLivePnl(entry, ltpMap) {
    if (!entry || !Array.isArray(entry.legs) || entry.legs.length === 0) return null;
    var leg = entry.legs[0];
    var sym = leg.symbol;
    var shortSym = leg.short_symbol;
    var side = (leg.side || '').toUpperCase();
    var entryPrice = Number(leg.price);
    var qtyLots = (entry.metadata && Number(entry.metadata.qty_lots)) || 1;
    var pv = autoGsPointValue(shortSym);
    var ltp = ltpMap.get(sym);
    if (!isFinite(entryPrice) || !pv || !isFinite(ltp)) return null;
    var sideSign = side === 'BUY' ? 1 : -1;
    var pnl = sideSign * (ltp - entryPrice) * qtyLots * pv;
    var breakdown = side + ' ' + qtyLots + ' lot · entry ' + entryPrice + ' → LTP ' + ltp +
                    ' · move ' + (ltp - entryPrice).toFixed(2) + ' × pv ' + pv;
    return { pnl: pnl, ltp: ltp, breakdown: breakdown };
}

async function autoLoadGsOpenTrades(silent) {
    var el = document.getElementById('au-gs-open-content');
    var statusEl = document.getElementById('au-gs-open-status');
    if (!el) return;
    if (!silent) {
        if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
        if (!el.firstElementChild || el.firstElementChild.tagName !== 'DIV' || !el.firstElementChild.querySelector('table')) {
            // Only show the spinner if there's no rendered table yet — auto-refresh
            // keeps the existing table on screen for smooth flicker-free updates.
            el.innerHTML = '<div class="au-meta">⏳ Loading GS open trades…</div>';
        }
    }

    try {
        var webhookStrats = await autoGetWebhookStrategyNames();

        // 1. Open trades from v_auto_open_trades, filtered to webhook strategies
        var openResp = await fetch(SUPABASE_URL + '/rest/v1/v_auto_open_trades?select=*', { headers: wmsHeaders() });
        var openAll = await openResp.json();
        var openRows = (openAll || []).filter(function (r) { return webhookStrats.has(r.strategy_name); });

        if (openRows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No open GS trades. When the analyst\'s MS007 fires an ENTRY alert, a row will appear here.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 open'; }
            return;
        }

        // 2. Fetch ENTRY signals for those trade_ids
        var tradeIds = openRows.map(function (r) { return r.trade_id; });
        var idsList = tradeIds.map(encodeURIComponent).join(',');
        var sigResp = await fetch(
            SUPABASE_URL + '/rest/v1/auto_signals?event_type=eq.ENTRY&trade_id=in.(' + idsList + ')&select=id,trade_id,strategy_name,fired_at,direction,legs,metadata',
            { headers: wmsHeaders() }
        );
        var sigRows = await sigResp.json();
        var byTrade = {};
        sigRows.forEach(function (s) { byTrade[s.trade_id] = s; });

        // 3. Live LTP for unique executed symbols — sourced from the shared price
        //    cache (wmsLivePrices), kept warm by the single app-wide refresh timer.
        var uniqSyms = Array.from(new Set(sigRows.map(function (s) {
            return (s.legs && s.legs[0] && s.legs[0].symbol) || null;
        }).filter(Boolean)));
        // Register these symbols with the shared refresh list so the app-wide
        // timer fetches them every cycle (E.11.10).
        _auGsSyms = uniqSyms.map(function (s) { return { fyersKey: s, cacheKey: s.replace(/^[A-Z]+:/, '') }; });
        if (typeof wmsBuildRefreshSymbols === 'function') wmsBuildRefreshSymbols();
        // On a user-initiated (non-silent) load, warm the cache once if these
        // symbols aren't priced yet — the silent shared-refresh cycles just read.
        if (!silent && typeof wmsStandardRefresh === 'function' && window.fyersToken) {
            var cold = uniqSyms.some(function (s) {
                var b = s.replace(/^[A-Z]+:/, '');
                var r = (window.wmsLivePrices || {})[s] || (window.wmsLivePrices || {})[b];
                return !(r && r.lp > 0);
            });
            if (cold) { try { await wmsStandardRefresh(true); } catch (_e) {} }
        }
        var ltpMap = autoFetchLtpForSymbols(uniqSyms);

        var now = Date.now();
        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Side</th>' +
                '<th style="padding:6px 8px">Entry<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ days held</span></th>' +
                '<th style="padding:6px 8px">Contract</th>' +
                '<th style="padding:6px 8px;text-align:right">Qty</th>' +
                '<th style="padding:6px 8px;text-align:right">Entry Px<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ SL</span></th>' +
                '<th style="padding:6px 8px;text-align:right">LTP</th>' +
                '<th style="padding:6px 8px;text-align:right">Exposure</th>' +
                '<th style="padding:6px 8px;text-align:right">Margin<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ %</span></th>' +
                '<th style="padding:6px 8px;text-align:right">Live P&amp;L<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ % of exp</span></th>' +
                '<th style="padding:6px 8px">Action</th>' +
                '</tr></thead><tbody>';

        var totalPnl = 0, anyPnl = false;
        var totalExposure = 0, totalMargin = 0, anyExposure = false;
        openRows.forEach(function (ot) {
            var sig = byTrade[ot.trade_id];
            var leg = sig && sig.legs && sig.legs[0];
            var m = (sig && sig.metadata) || {};
            var side = sig ? (sig.direction || (leg && leg.side === 'BUY' ? 'LONG' : 'SHORT')) : '—';
            var sideBadge = side === 'LONG'
                ? '<span class="au-badge success">LONG</span>'
                : side === 'SHORT'
                    ? '<span class="au-badge error">SHORT</span>'
                    : autoEsc(side);
            var entryStr = sig ? autoFmtIST(sig.fired_at) : '—';
            var daysHeld = sig ? Math.floor((now - new Date(sig.fired_at).getTime()) / 86400000) : null;
            var daysSub = daysHeld != null
                ? '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + daysHeld + ' day' + (daysHeld === 1 ? '' : 's') + '</div>'
                : '';
            var contract = leg ? autoFmtContract(leg.symbol, leg.expiry_date) : '—';
            var shortSym = leg ? leg.short_symbol : null;
            var entryPriceNum = leg && leg.price != null ? Number(leg.price) : null;
            var stopPriceNum = m.stop_price != null ? Number(m.stop_price) : null;

            // Qty cell: "5 lots" + sub-row "25 kg" (physical size if known).
            var qtyLots = m.qty_lots != null ? Number(m.qty_lots) : (leg ? Number(leg.qty) : null);
            var qtyMain = qtyLots != null ? qtyLots + ' lot' + (qtyLots == 1 ? '' : 's') : '—';
            var physLot = autoGsPhysicalLot(shortSym);
            var qtySub = '';
            if (qtyLots != null && physLot) {
                var totalPhys = qtyLots * physLot.qty;
                qtySub = '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + totalPhys + ' ' + physLot.unit + '</div>';
            }
            var qtyCell = autoEsc(qtyMain) + qtySub;

            // Entry Px cell: main = entry price (zero decimals); sub = "SL: 272,661" rounded to 0 decimals.
            var entryPxMain = autoFmtPrice0(entryPriceNum);
            var stopSub = stopPriceNum != null
                ? '<div style="color:#6b7280;font-size:10px;margin-top:1px">SL: ' + autoFmtPrice0(stopPriceNum) + '</div>'
                : '';

            // Exposure = qty_lots × point_value × entry_price  (₹ notional).
            // For SILVERM 7 lots @ ₹273,000: 7 × 5 × 273,000 = ₹95,55,000.
            var pv = shortSym ? autoGsPointValue(shortSym) : null;
            var exposure = (qtyLots != null && pv && entryPriceNum != null) ? (qtyLots * pv * entryPriceNum) : null;
            var exposureCell = exposure != null
                ? '₹' + Math.round(exposure).toLocaleString('en-IN')
                : '<span style="color:#9ca3af">—</span>';
            if (exposure != null) { totalExposure += exposure; anyExposure = true; }

            // Margin = exposure × margin_pct/100. Per-instrument %, see
            // AU_GS_MARGIN_PCT. Sub-row shows the % used.
            var marginPct = shortSym ? autoGsMarginPct(shortSym) : null;
            var margin = (exposure != null && marginPct != null) ? (exposure * marginPct / 100) : null;
            var marginCell;
            if (margin != null) {
                totalMargin += margin;
                marginCell = '₹' + Math.round(margin).toLocaleString('en-IN') +
                             '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + marginPct + '%</div>';
            } else {
                marginCell = '<span style="color:#9ca3af">—</span>';
            }

            var pnlInfo = sig ? autoGsComputeLivePnl(sig, ltpMap) : null;
            var ltpCell, pnlCell, pnlTooltip;
            if (pnlInfo) {
                anyPnl = true;
                totalPnl += pnlInfo.pnl;
                ltpCell = autoFmtPrice0(pnlInfo.ltp);
                var sign = pnlInfo.pnl >= 0 ? '+' : '−';
                var col = pnlInfo.pnl >= 0 ? '#047857' : '#dc2626';
                var abs = Math.abs(Math.round(pnlInfo.pnl)).toLocaleString('en-IN');
                var pctSub = '';
                if (exposure && exposure > 0) {
                    var pct = (pnlInfo.pnl / exposure) * 100;
                    var pctSign = pct >= 0 ? '+' : '−';
                    pctSub = '<div style="color:' + col + ';font-size:10px;margin-top:1px;font-weight:500">' +
                             pctSign + Math.abs(pct).toFixed(2) + '%</div>';
                }
                pnlCell = '<span style="color:' + col + ';font-weight:600">' + sign + '₹' + abs + '</span>' + pctSub;
                pnlTooltip = pnlInfo.breakdown;
            } else {
                ltpCell = '<span style="color:#9ca3af">—</span>';
                pnlCell = '<span style="color:#9ca3af">—</span>';
                pnlTooltip = 'Live P&L needs (a) Fyers connection for LTP and (b) a known point_value for the underlying.';
            }

            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;vertical-align:top"><code>' + autoEsc(ot.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + sideBadge + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + autoEsc(entryStr) + daysSub + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + autoEsc(contract) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + qtyCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + autoEsc(entryPxMain) + stopSub + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + ltpCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + exposureCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + marginCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;white-space:nowrap;vertical-align:top" title="' + autoEsc(pnlTooltip) + '">' + pnlCell + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top"><button class="au-btn au-btn-danger" style="padding:4px 8px;font-size:11px"' +
                        ' onclick="autoManualClose(' + JSON.stringify(ot.trade_id).replace(/"/g, '&quot;') + ')">✕ Close</button></td>' +
                    '</tr>';
        });

        if (anyExposure || anyPnl) {
            var expCell = anyExposure
                ? '₹' + Math.round(totalExposure).toLocaleString('en-IN')
                : '<span style="color:#9ca3af">—</span>';
            var mgnCell = anyExposure
                ? '₹' + Math.round(totalMargin).toLocaleString('en-IN')
                : '<span style="color:#9ca3af">—</span>';
            var pnlTotalCell;
            if (anyPnl) {
                var tSign = totalPnl >= 0 ? '+' : '−';
                var tCol = totalPnl >= 0 ? '#047857' : '#dc2626';
                var tAbs = Math.abs(Math.round(totalPnl)).toLocaleString('en-IN');
                var totPctSub = '';
                if (anyExposure && totalExposure > 0) {
                    var totPct = (totalPnl / totalExposure) * 100;
                    var totPctSign = totPct >= 0 ? '+' : '−';
                    totPctSub = '<div style="color:' + tCol + ';font-size:10px;margin-top:1px;font-weight:500">' +
                                totPctSign + Math.abs(totPct).toFixed(2) + '%</div>';
                }
                pnlTotalCell = '<span style="color:' + tCol + '">' + tSign + '₹' + tAbs + '</span>' + totPctSub;
            } else {
                pnlTotalCell = '<span style="color:#9ca3af">—</span>';
            }
            html += '<tfoot><tr style="border-top:2px solid #cbd5e0;background:#f7fafc;font-weight:700">' +
                    '<td colspan="7" style="padding:8px;text-align:right">Totals (' + openRows.length + ' open):</td>' +
                    '<td style="padding:8px;text-align:right;vertical-align:top">' + expCell + '</td>' +
                    '<td style="padding:8px;text-align:right;vertical-align:top">' + mgnCell + '</td>' +
                    '<td style="padding:8px;text-align:right;vertical-align:top">' + pnlTotalCell + '</td>' +
                    '<td style="padding:8px"></td>' +
                    '</tr></tfoot>';
        }
        html += '</table></div>';
        html += '<div class="au-meta" style="margin-top:8px;font-size:11px;color:#6b7280;line-height:1.6">' +
                '• LTP via Fyers /quotes (needs active Fyers connection).<br>' +
                '• Lot sizes: SILVERM 1 lot = 5 kg · GOLDM 1 lot = 100 g.<br>' +
                '• Exposure = lots × point_value × entry price.<br>' +
                '• Margin: SILVERM 20% · GOLDM 10% (Fyers SPAN+exposure, rounded up).<br>' +
                '• P&amp;L = side × (LTP − entry) × lots × point_value.' +
                '</div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = openRows.length + ' open'; }

        // Populate shared totals state for the sticky bar
        _auGsTotals.openCount = openRows.length;
        _auGsTotals.openExposure = anyExposure ? totalExposure : null;
        _auGsTotals.openMargin = anyExposure ? totalMargin : null;
        _auGsTotals.openLivePnl = anyPnl ? totalPnl : null;
        autoUpdateGsTotalsBar();
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load GS open trades: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

async function autoLoadGsClosedTrades() {
    var el = document.getElementById('au-gs-closed-content');
    var statusEl = document.getElementById('au-gs-closed-status');
    if (!el) return;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
    el.innerHTML = '<div class="au-meta">⏳ Loading GS closed trades…</div>';

    try {
        var webhookStrats = await autoGetWebhookStrategyNames();

        // Fetch GS auto_signals (last _AU_CLOSED_LIMIT events). Group by trade_id,
        // include only trades that have at least one EXIT/MANUAL_CLOSE and net to
        // zero qty.
        //
        // Filter by strategy_name — NOT by source. The GS strategies migrated from
        // tv-webhook execution to the automation-runner (chassis) in Jun 2026, so
        // pre-migration signals have `source='tv_webhook'` and post-migration ones
        // have `source='chassis'` (the auto_signals.source default from migration 41).
        // A strategy-name filter cleanly covers both eras.
        var stratList = Array.from(webhookStrats).map(function (n) { return '"' + n + '"'; }).join(',');
        var sigs = [];
        if (stratList) {
            var resp = await fetch(
                SUPABASE_URL + '/rest/v1/auto_signals?strategy_name=in.(' + encodeURIComponent(stratList) +
                ')&order=fired_at.desc&limit=' + _AU_CLOSED_LIMIT +
                '&select=id,trade_id,strategy_name,fired_at,event_type,direction,legs,metadata,source',
                { headers: wmsHeaders() }
            );
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
            sigs = await resp.json();
            if (!Array.isArray(sigs)) sigs = [];
        }

        // Source filter — shared state variable so BOTH the Legacy dropdown
        // (au-gs-closed-source-filter) and the new GS family page dropdown
        // (au-gs-fam-closed-source-filter) stay in sync. Updated via
        // autoGsSetClosedSourceFilter() which is wired to both onchange handlers.
        // Values: 'all' (default), 'chassis' (automation-runner), 'tv_webhook' (legacy Pine).
        // The trade's source is the ENTRY row's source; EXIT can differ (e.g. legacy
        // tv_webhook entry + a MANUAL_CLOSE chassis exit) but ENTRY defines origin.
        var _srcFilter = _auGsClosedSourceFilter || 'all';

        var byTrade = {};
        sigs.forEach(function (s) {
            if (!s.trade_id) return;
            if (!byTrade[s.trade_id]) byTrade[s.trade_id] = [];
            byTrade[s.trade_id].push(s);
        });

        // Peak exposure / margin computation (HIGH-WATER mark — entries add,
        // exits subtract the matching ENTRY's value, not the EXIT's leg.qty
        // which may be ATR-mismatched per D.26). The running total at any
        // moment = sum of currently-open trades' entry exposures. Max of that
        // running total is the peak.
        //
        // Filter-aware (2026-07-09): when the source filter is set to a
        // specific value, the peak is computed as if only that source ever
        // existed — i.e. we walk only the signals whose ENTRY source matches.
        // "Peak exposure for chassis-only" answers "max risk from that source
        // alone" — the more useful lens for a per-source risk review.
        var sigsAsc = sigs.slice().sort(function (a, b) {
            return a.fired_at < b.fired_at ? -1 : a.fired_at > b.fired_at ? 1 : 0;
        });
        var entryByTrade = {};
        sigsAsc.forEach(function (s) {
            if (s.event_type === 'ENTRY') entryByTrade[s.trade_id] = s;
        });
        function _gsTradeExposureOf(entrySig) {
            if (!entrySig || !entrySig.legs || !entrySig.legs[0]) return { exp: 0, mgn: 0 };
            var leg = entrySig.legs[0];
            var em = entrySig.metadata || {};
            var qLots = em.qty_lots != null ? Number(em.qty_lots) : Number(leg.qty || 0);
            var pv  = autoGsPointValue(leg.short_symbol);
            var mP  = autoGsMarginPct(leg.short_symbol);
            var exp = (qLots && pv && leg.price != null) ? (qLots * pv * Number(leg.price)) : 0;
            var mgn = mP ? (exp * mP / 100) : 0;
            return { exp: exp, mgn: mgn };
        }
        // Apply source filter to the peak walk. 'all' → walk everything;
        // 'chassis' / 'tv_webhook' → only signals whose ENTRY row matches.
        var peakSigs = sigsAsc;
        if (_srcFilter === 'chassis' || _srcFilter === 'tv_webhook') {
            peakSigs = sigsAsc.filter(function (s) {
                var e = entryByTrade[s.trade_id];
                return e && e.source === _srcFilter;
            });
        }
        var _runExp = 0, _runMgn = 0;
        var _peakExp = 0, _peakMgn = 0;
        peakSigs.forEach(function (s) {
            var entrySig = entryByTrade[s.trade_id];
            var em = _gsTradeExposureOf(entrySig);
            if (s.event_type === 'ENTRY') { _runExp += em.exp; _runMgn += em.mgn; }
            else                          { _runExp -= em.exp; _runMgn -= em.mgn; }
            if (_runExp > _peakExp) _peakExp = _runExp;
            if (_runMgn > _peakMgn) _peakMgn = _runMgn;
        });
        _auGsTotals.peakExposure = _peakExp > 0 ? _peakExp : null;
        _auGsTotals.peakMargin   = _peakMgn > 0 ? _peakMgn : null;
        _auGsTotals.peakSourceFilter = _srcFilter;  // for label rendering

        var closedRows = [];
        Object.keys(byTrade).forEach(function (tradeId) {
            var events = byTrade[tradeId];
            var hasExit = false;
            var netQty = 0;
            var entry = null, exit = null;
            events.forEach(function (s) {
                if (s.event_type !== 'ENTRY') hasExit = true;
                if (s.event_type === 'ENTRY') {
                    if (!entry || s.fired_at < entry.fired_at) entry = s;
                } else {
                    if (!exit || s.fired_at > exit.fired_at) exit = s;
                }
                (s.legs || []).forEach(function (l) {
                    var q = Number(l.qty) || 0;
                    if ((l.side || '').toUpperCase() === 'BUY')  netQty += q;
                    if ((l.side || '').toUpperCase() === 'SELL') netQty -= q;
                });
            });
            if (!hasExit || !entry) return;
            if (Math.abs(netQty) > 1e-6) return;

            // Compute realised P&L: side_sign × (exit_price − entry_price) × qty_lots × point_value
            var leg = entry.legs && entry.legs[0];
            var em = entry.metadata || {};
            var qtyLots = em.qty_lots != null ? em.qty_lots : (leg ? leg.qty : 1);
            var pv = leg ? autoGsPointValue(leg.short_symbol) : null;
            var entryPx = leg ? Number(leg.price) : null;
            var exitLeg = exit && exit.legs && exit.legs[0];
            var exitPx = exitLeg ? Number(exitLeg.price) : null;
            var pnl = null;
            if (pv && isFinite(entryPx) && isFinite(exitPx)) {
                var sideSign = (leg.side || '').toUpperCase() === 'BUY' ? 1 : -1;
                pnl = sideSign * (exitPx - entryPx) * qtyLots * pv;
            }

            var _entrySrc = entry.source || null;
            var _entryVer = (entry.metadata && (entry.metadata.strategy_version || entry.metadata.version)) || null;
            closedRows.push({
                trade_id: tradeId,
                strategy_name: entry.strategy_name,
                entry: entry, exit: exit,
                entry_price: entryPx, exit_price: exitPx, qty_lots: qtyLots,
                pnl: pnl,
                contract: leg ? leg.symbol : '—',
                expiry_date: leg ? leg.expiry_date : null,
                short_symbol: leg ? leg.short_symbol : null,
                source: _entrySrc,       // 'chassis' | 'tv_webhook' | null
                version: _entryVer,      // e.g. 'v2.2' or 'MS007-v2.0' or null
            });
        });

        // Sort most-recently-closed first
        closedRows.sort(function (a, b) {
            var aT = a.exit ? a.exit.fired_at : a.entry.fired_at;
            var bT = b.exit ? b.exit.fired_at : b.entry.fired_at;
            return bT < aT ? -1 : bT > aT ? 1 : 0;
        });

        // Apply the source filter now (after we've built the totals bar's peak
        // exposure / peak margin — those figures reflect ALL closed trades so
        // filter changes don't distort the sticky-totals values).
        var _closedTotal = closedRows.length;
        if (_srcFilter === 'chassis' || _srcFilter === 'tv_webhook') {
            closedRows = closedRows.filter(function (ct) { return ct.source === _srcFilter; });
        }

        if (closedRows.length === 0) {
            var _emptyMsg = _closedTotal === 0
                ? 'No closed GS trades yet.'
                : 'No closed GS trades match filter "' + autoEsc(_srcFilter) + '" (' + _closedTotal + ' hidden). Change filter above to see them.';
            el.innerHTML = '<div class="au-soon" style="padding:20px">' + _emptyMsg + '</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 / ' + _closedTotal + ' closed'; }
            return;
        }

        // Compute totals up front so we can render the total row at the TOP
        // (owner ask 2026-07-09 — with many trades, scrolling to the tfoot is tedious).
        var _totalPnl = 0, _wins = 0, _losses = 0;
        var _totalExposure = 0, _anyExposure = false;
        closedRows.forEach(function (ct) {
            var _lg = ct.entry.legs && ct.entry.legs[0];
            var _pv = _lg ? autoGsPointValue(_lg.short_symbol) : null;
            var _mgPct = _lg ? autoGsMarginPct(_lg.short_symbol) : null;
            if (_pv && ct.qty_lots && ct.entry_price != null) {
                var _exp = Number(ct.qty_lots) * _pv * Number(ct.entry_price);
                if (isFinite(_exp) && _exp > 0) { _totalExposure += _exp; _anyExposure = true; }
            }
            if (ct.pnl != null) {
                _totalPnl += ct.pnl;
                if (ct.pnl >= 0) _wins++; else _losses++;
            }
        });
        var _tSign = _totalPnl >= 0 ? '+' : '−';
        var _tCol  = _totalPnl >= 0 ? '#047857' : '#dc2626';
        var _tAbs  = Math.abs(Math.round(_totalPnl)).toLocaleString('en-IN');
        var _tPctSub = '';
        if (_anyExposure && _totalExposure > 0) {
            var _tPct = (_totalPnl / _totalExposure) * 100;
            var _tPctSign = _tPct >= 0 ? '+' : '−';
            _tPctSub = '<div style="color:' + _tCol + ';font-size:10px;margin-top:1px;font-weight:500">' +
                        _tPctSign + Math.abs(_tPct).toFixed(2) + '%</div>';
        }
        var _totalLabel = 'Total (' + closedRows.length + ' closed — ' + _wins + 'W / ' + _losses + 'L' +
                         (_srcFilter !== 'all' ? ' — filtered from ' + _closedTotal : '') + ')';

        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead>' +
                // Row 1 — totals (sticky at top so it stays visible even during vertical scroll of the table)
                '<tr style="background:#f7fafc;border-bottom:2px solid #cbd5e0;font-weight:700;position:sticky;top:0">' +
                '<td colspan="9" style="padding:8px">' + autoEsc(_totalLabel) + '</td>' +
                '<td style="padding:8px;text-align:right;vertical-align:top;white-space:nowrap">' +
                '<span style="color:' + _tCol + '">' + _tSign + '₹' + _tAbs + '</span>' + _tPctSub +
                '</td>' +
                '</tr>' +
                // Row 2 — column headers
                '<tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Strategy<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ source · version</span></th>' +
                '<th style="padding:6px 8px">Side</th>' +
                '<th style="padding:6px 8px">Entry</th>' +
                '<th style="padding:6px 8px">Exit<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ days held</span></th>' +
                '<th style="padding:6px 8px">Contract</th>' +
                '<th style="padding:6px 8px;text-align:right">Qty</th>' +
                '<th style="padding:6px 8px;text-align:right">Entry Px</th>' +
                '<th style="padding:6px 8px;text-align:right">Exit Px</th>' +
                '<th style="padding:6px 8px">Exit Reason</th>' +
                '<th style="padding:6px 8px;text-align:right">Realised P&amp;L<br><span style="font-weight:400;color:#6b7280;font-size:10px">/ % of exp</span></th>' +
                '</tr></thead><tbody>';

        var totalPnl = 0, wins = 0, losses = 0;
        var totalExposure = 0, anyExposure = false;
        closedRows.forEach(function (ct) {
            var leg = ct.entry.legs && ct.entry.legs[0];
            var side = ct.entry.direction || (leg && leg.side === 'BUY' ? 'LONG' : 'SHORT');
            var sideBadge = side === 'LONG'
                ? '<span class="au-badge success">LONG</span>'
                : side === 'SHORT' ? '<span class="au-badge error">SHORT</span>' : autoEsc(side);
            var entryStr = autoFmtIST(ct.entry.fired_at);
            var exitStr = ct.exit ? autoFmtIST(ct.exit.fired_at) : '—';
            var daysHeld = ct.exit
                ? Math.max(0, Math.floor((new Date(ct.exit.fired_at).getTime() - new Date(ct.entry.fired_at).getTime()) / 86400000))
                : null;
            var daysSub = daysHeld != null
                ? '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + daysHeld + ' day' + (daysHeld === 1 ? '' : 's') + '</div>'
                : '';
            var exitType = ct.exit ? ct.exit.event_type : '—';
            var exitTypeColor = _autoExitTypeColor(exitType);
            var entryPxStr = autoFmtPrice0(ct.entry_price);
            var exitPxStr = autoFmtPrice0(ct.exit_price);
            var contractStr = autoFmtContract(ct.contract, ct.expiry_date);

            // Qty cell: lots + physical sub-row
            var qtyLots = ct.qty_lots != null ? Number(ct.qty_lots) : null;
            var qtyMain = qtyLots != null ? qtyLots + ' lot' + (qtyLots == 1 ? '' : 's') : '—';
            var physLot = autoGsPhysicalLot(ct.short_symbol);
            var qtySub = '';
            if (qtyLots != null && physLot) {
                qtySub = '<div style="color:#6b7280;font-size:10px;margin-top:1px">' + (qtyLots * physLot.qty) + ' ' + physLot.unit + '</div>';
            }
            var qtyCell = autoEsc(qtyMain) + qtySub;

            // Exposure for % calc (same formula as Open Trades): lots × pv × entry_price
            var pv = ct.short_symbol ? autoGsPointValue(ct.short_symbol) : null;
            var exposure = (qtyLots != null && pv && ct.entry_price != null) ? (qtyLots * pv * ct.entry_price) : null;
            if (exposure != null) { totalExposure += exposure; anyExposure = true; }

            var pnlCell;
            if (ct.pnl != null) {
                totalPnl += ct.pnl;
                if (ct.pnl >= 0) wins++; else losses++;
                var sign = ct.pnl >= 0 ? '+' : '−';
                var col = ct.pnl >= 0 ? '#047857' : '#dc2626';
                var abs = Math.abs(Math.round(ct.pnl)).toLocaleString('en-IN');
                var pctSub = '';
                if (exposure && exposure > 0) {
                    var pct = (ct.pnl / exposure) * 100;
                    var pctSign = pct >= 0 ? '+' : '−';
                    pctSub = '<div style="color:' + col + ';font-size:10px;margin-top:1px;font-weight:500">' +
                             pctSign + Math.abs(pct).toFixed(2) + '%</div>';
                }
                pnlCell = '<span style="color:' + col + ';font-weight:600">' + sign + '₹' + abs + '</span>' + pctSub;
            } else {
                pnlCell = '<span style="color:#9ca3af">—</span>';
            }

            // Source + version go under the Strategy code, as a small grey sub-line.
            var srcLabel = ct.source === 'chassis' ? 'Runner'
                         : ct.source === 'tv_webhook' ? 'TV Webhook'
                         : (ct.source ? autoEsc(String(ct.source)) : '—');
            var srcColor = ct.source === 'chassis' ? '#4338ca'
                         : ct.source === 'tv_webhook' ? '#0891b2'
                         : '#6b7280';
            var verStr = ct.version ? autoEsc(String(ct.version)) : '—';
            var strategyCell = '<code>' + autoEsc(ct.strategy_name) + '</code>' +
                '<div style="font-size:10px;margin-top:2px">' +
                    '<span style="color:' + srcColor + ';font-weight:500">' + srcLabel + '</span>' +
                    '<span style="color:#9ca3af"> · </span>' +
                    '<span style="color:#6b7280">' + verStr + '</span>' +
                '</div>';

            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;vertical-align:top">' + strategyCell + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + sideBadge + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + autoEsc(entryStr) + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + autoEsc(exitStr) + daysSub + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top">' + autoEsc(contractStr) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + qtyCell + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + autoEsc(entryPxStr) + '</td>' +
                    '<td style="padding:6px 8px;text-align:right;vertical-align:top">' + autoEsc(exitPxStr) + '</td>' +
                    '<td style="padding:6px 8px;vertical-align:top"><span style="color:' + exitTypeColor + ';font-weight:600">' + autoEsc(_autoExitTypeLabel(exitType)) + '</span></td>' +
                    '<td style="padding:6px 8px;text-align:right;white-space:nowrap;vertical-align:top">' + pnlCell + '</td>' +
                    '</tr>';
        });

        // Totals row now renders at the TOP of the table (see thead above) —
        // no tfoot needed. totalPnl/wins/losses computed inside the loop above
        // are still used to populate _auGsTotals for the sticky totals bar.
        html += '</tbody></table></div>';
        el.innerHTML = html;
        var _statusLabel = _srcFilter === 'all'
            ? closedRows.length + ' closed'
            : closedRows.length + ' / ' + _closedTotal + ' closed';
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = _statusLabel; }

        // Populate shared totals state for the sticky bar
        _auGsTotals.closedCount = closedRows.length;
        _auGsTotals.closedWins = wins;
        _auGsTotals.closedLosses = losses;
        _auGsTotals.closedRealisedPnl = totalPnl;
        autoUpdateGsTotalsBar();
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load GS closed trades: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----------------------------------------------------------------------------
// Recent Events tab — auto_signals listing
// ----------------------------------------------------------------------------

async function autoLoadEvents(filter) {
    window._auEventsFilter = filter || 'all';
    var el = document.getElementById('au-events-content');
    var statusEl = document.getElementById('au-events-status');
    if (!el) return;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
    el.innerHTML = '<div class="au-meta">⏳ Loading events…</div>';

    var qs = '?select=id,trade_id,strategy_name,fired_at,event_type,direction,score,email_status,email_subject,metadata&order=fired_at.desc&limit=50';
    if (filter === 'ENTRY')        qs += '&event_type=eq.ENTRY';
    else if (filter === 'EXIT')    qs += '&event_type=neq.ENTRY';
    else if (filter === 'email-failed') qs += '&email_status=eq.FAILED';

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/auto_signals' + qs, { headers: wmsHeaders() });
        var rows = await resp.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No events match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 events'; }
            return;
        }

        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Time</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Pair</th>' +
                '<th style="padding:6px 8px">Type</th>' +
                '<th style="padding:6px 8px">Score</th>' +
                '<th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px">Trade</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (s) {
            var m = s.metadata || {};
            var pair = m.Pair || '—';
            var typeColor = s.event_type === 'ENTRY' ? '#047857' :
                           s.event_type === 'TARGET_HIT' ? '#0891b2' :
                           s.event_type === 'STOP_HIT' ? '#dc2626' :
                           s.event_type === 'TIME_STOP' ? '#92400e' : '#6b7280';
            var emailBadge = s.email_status === 'SENT' ? '<span class="au-badge success">sent</span>' :
                             s.email_status === 'FAILED' ? '<span class="au-badge error">failed</span>' :
                             s.email_status === 'PENDING' ? '<span class="au-badge loading">pending</span>' :
                             '<span class="au-badge idle">—</span>';
            var tradeFrag = s.trade_id ? s.trade_id.slice(0, 8) + '…' : '—';
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap">' + autoEsc(autoFmtIST(s.fired_at)) + '</td>' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(s.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px"><strong>' + autoEsc(pair) + '</strong></td>' +
                    '<td style="padding:6px 8px;color:' + typeColor + ';font-weight:600">' + autoEsc(s.event_type) + '</td>' +
                    '<td style="padding:6px 8px">' + (s.score != null ? s.score : '—') + '</td>' +
                    '<td style="padding:6px 8px">' + emailBadge + '</td>' +
                    '<td style="padding:6px 8px;font-family:monospace;font-size:11px">' + autoEsc(tradeFrag) + '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' events'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ----------------------------------------------------------------------------
// Run History tab — auto_runs listing
// ----------------------------------------------------------------------------

async function autoLoadRuns(filter) {
    window._auRunsFilter = filter || 'all';
    var el = document.getElementById('au-runs-content');
    var statusEl = document.getElementById('au-runs-status');
    if (!el) return;
    if (statusEl) { statusEl.className = 'au-badge loading'; statusEl.textContent = 'loading'; }
    el.innerHTML = '<div class="au-meta">⏳ Loading runs…</div>';

    var qs = '?select=id,strategy_name,started_at,finished_at,duration_ms,status,signals_generated,emails_sent,emails_failed,error&order=started_at.desc&limit=50';
    if (filter === 'pairs')           qs += '&strategy_name=eq.pairs';
    else if (filter === '_eod_ingest') qs += '&strategy_name=eq._eod_ingest';
    else if (filter === 'failed')     qs += '&status=eq.FAILED';

    try {
        var resp = await fetch(SUPABASE_URL + '/rest/v1/auto_runs' + qs, { headers: wmsHeaders() });
        var rows = await resp.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            el.innerHTML = '<div class="au-soon" style="padding:20px">No runs match this filter.</div>';
            if (statusEl) { statusEl.className = 'au-badge idle'; statusEl.textContent = '0 runs'; }
            return;
        }

        var html = '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">';
        html += '<thead><tr style="background:#f3f4f6;text-align:left">' +
                '<th style="padding:6px 8px">Started</th>' +
                '<th style="padding:6px 8px">Strategy</th>' +
                '<th style="padding:6px 8px">Status</th>' +
                '<th style="padding:6px 8px">Signals</th>' +
                '<th style="padding:6px 8px">Email</th>' +
                '<th style="padding:6px 8px">Duration</th>' +
                '<th style="padding:6px 8px">Error</th>' +
                '</tr></thead><tbody>';
        rows.forEach(function (r) {
            var emailCell = '—';
            if (r.emails_sent || r.emails_failed) {
                var sent = r.emails_sent || 0, failed = r.emails_failed || 0;
                emailCell = (failed > 0 ? '<span style="color:#dc2626">' + failed + ' failed</span>' : '') +
                            (sent > 0 && failed > 0 ? ' / ' : '') +
                            (sent > 0 ? '<span style="color:#047857">' + sent + ' sent</span>' : '');
            }
            html += '<tr style="border-top:1px solid #e5e7eb">' +
                    '<td style="padding:6px 8px;white-space:nowrap">' + autoEsc(autoFmtIST(r.started_at)) + '</td>' +
                    '<td style="padding:6px 8px"><code>' + autoEsc(r.strategy_name) + '</code></td>' +
                    '<td style="padding:6px 8px">' + autoStatusBadge(r.status) + '</td>' +
                    '<td style="padding:6px 8px">' + (r.signals_generated != null ? r.signals_generated : '—') + '</td>' +
                    '<td style="padding:6px 8px;font-size:11px">' + emailCell + '</td>' +
                    '<td style="padding:6px 8px">' + autoFmtDuration(r.duration_ms) + '</td>' +
                    '<td style="padding:6px 8px;color:#7f1d1d;font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis" title="' + autoEsc(r.error || '') + '">' +
                        autoEsc((r.error || '').slice(0, 80)) + (r.error && r.error.length > 80 ? '…' : '') +
                    '</td>' +
                    '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
        if (statusEl) { statusEl.className = 'au-badge success'; statusEl.textContent = rows.length + ' runs'; }
    } catch (e) {
        el.innerHTML = '<span style="color:#dc2626">Failed to load: ' + autoEsc(String(e)) + '</span>';
        if (statusEl) { statusEl.className = 'au-badge error'; statusEl.textContent = 'error'; }
    }
}

// ============================================================================
// Live Trading tab (Phase 13) — LIVE order-placement controls + risk wrappers
// ----------------------------------------------------------------------------
// Reads/writes app_state (kill switch + per-source pause) and wms_live_risk_limits
// (the rules the katalysthive-webhook enforces before placing orders). All writes
// go through the owner's session JWT (RLS owner_all). No SQL, no deploy.
// ============================================================================

var _auLiveState  = null;   // app_state singleton row
var _auLiveLimits = [];     // wms_live_risk_limits rows
var AU_KH = { source: 'katalysthive', strategy: 'sharanaga_v1' };
var _AU_INP = 'padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:12px';

async function autoLoadLive() {
    var ctrl = document.getElementById('au-live-controls');
    if (ctrl) ctrl.innerHTML = 'Loading…';
    try {
        var results = await Promise.all([
            fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1&select=kill_switch,paused_sources,paused_brokers', { headers: wmsHeaders() }),
            fetch(SUPABASE_URL + '/rest/v1/wms_live_risk_limits?select=*', { headers: wmsHeaders() })
        ]);
        var sRows = await results[0].json();
        _auLiveState = (Array.isArray(sRows) && sRows[0]) || { kill_switch: false, paused_sources: [], paused_brokers: [] };
        _auLiveLimits = await results[1].json();
        if (!Array.isArray(_auLiveLimits)) _auLiveLimits = [];
        await _auSyncLotSizes();          // auto-derive lot sizes from securities_nfo cache (self-heals)
        autoRenderLiveControls();
        autoRenderKhWrappers();
        autoRenderLotSizes();
    } catch (e) {
        if (ctrl) ctrl.innerHTML = '<span style="color:#dc2626">Failed to load live config: ' + autoEsc(String(e)) + '</span>';
    }
}

function _auFindLimit(source, strategy, iba, type) {
    return _auLiveLimits.find(function (r) {
        return (r.signal_source || null) === (source || null)
            && (r.strategy_name || null) === (strategy || null)
            && (r.iba_id || null) === (iba || null)
            && r.limit_type === type;
    }) || null;
}

// ---- Live controls (kill switch + KH pause) ----
function autoRenderLiveControls() {
    var el = document.getElementById('au-live-controls'); if (!el) return;
    var ks = !!_auLiveState.kill_switch;
    var paused = (_auLiveState.paused_sources || []).indexOf('katalysthive') !== -1;
    var badge = document.getElementById('au-live-state-badge');
    if (badge) {
        if (ks)          { badge.textContent = 'KILL SWITCH ON'; badge.className = 'au-badge error'; }
        else if (paused) { badge.textContent = 'KH paused';      badge.className = 'au-badge warning'; }
        else             { badge.textContent = 'live';           badge.className = 'au-badge success'; }
    }
    el.innerHTML =
        '<div style="display:flex;gap:28px;flex-wrap:wrap;align-items:flex-end">' +
            '<div><div style="font-size:11px;color:#6b7280;margin-bottom:4px">Global kill switch (all sources)</div>' +
                '<button class="au-btn ' + (ks ? 'au-btn-danger' : 'au-btn-secondary') + '" onclick="autoToggleKillSwitch()">' +
                (ks ? '🛑 ON — click to resume trading' : 'Engage kill switch') + '</button></div>' +
            '<div><div style="font-size:11px;color:#6b7280;margin-bottom:4px">Katalysthive source</div>' +
                '<button class="au-btn ' + (paused ? 'au-btn-danger' : 'au-btn-secondary') + '" onclick="autoToggleKhPause()">' +
                (paused ? '⏸ Paused — click to resume' : 'Pause Katalysthive') + '</button></div>' +
        '</div>';
}

async function autoToggleKillSwitch() {
    var on = !!_auLiveState.kill_switch;
    var msg = on
        ? 'Resume LIVE order placement (turn the kill switch OFF)?'
        : '⚠️ Engage the GLOBAL kill switch?\n\nALL live order placement halts immediately. Every signal (Katalysthive + any future source) is rejected until you turn it off.';
    if (!confirm(msg)) return;
    await _auPatchAppState({ kill_switch: !on }, (on ? 'Resume from' : 'Engage') + ' kill switch (Live Trading tab)');
}

async function autoToggleKhPause() {
    var cur = _auLiveState.paused_sources || [];
    var paused = cur.indexOf('katalysthive') !== -1;
    var next = paused ? cur.filter(function (s) { return s !== 'katalysthive'; }) : cur.concat(['katalysthive']);
    var msg = paused
        ? 'Resume Katalysthive signals?'
        : 'Pause Katalysthive only?\n\nIts signals will be rejected (HTTP 503 SOURCE_PAUSED) until resumed. Other sources are unaffected.';
    if (!confirm(msg)) return;
    await _auPatchAppState({ paused_sources: next }, (paused ? 'Resume' : 'Pause') + ' katalysthive (Live Trading tab)');
}

async function _auPatchAppState(patch, reason) {
    try {
        patch.updated_by = (window.currentUser && window.currentUser.email) || 'app';
        patch.updated_reason = reason;
        var resp = await fetch(SUPABASE_URL + '/rest/v1/app_state?id=eq.1',
            { method: 'PATCH', headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: JSON.stringify(patch) });
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        autoLoadLive();
    } catch (e) { alert('Failed to update live controls: ' + (e.message || e)); }
}

// ---- Katalysthive risk wrappers ----
function autoRenderKhWrappers() {
    var el = document.getElementById('au-live-kh'); if (!el) return;
    var cap = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'max_open_exposure_lots');
    var und = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'allowed_underlyings');
    var capVal = (cap && cap.limit_value && cap.limit_value.value != null) ? cap.limit_value.value : '';
    var capOn  = cap ? cap.enabled : true;
    var undVals = (und && und.limit_value && Array.isArray(und.limit_value.values)) ? und.limit_value.values.join(', ') : '';
    var undOn  = und ? und.enabled : true;
    var lb = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'exposure_lookback_days');
    var lbVal = (lb && lb.limit_value && lb.limit_value.value != null) ? lb.limit_value.value : 3;
    el.innerHTML =
        '<div style="margin-bottom:18px">' +
            '<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:3px">Max open exposure (lots)' +
                (cap ? '' : ' <span style="color:#9ca3af;font-weight:400">— not set (no cap enforced)</span>') + '</div>' +
            '<div style="font-size:11px;color:#6b7280;margin-bottom:6px">Total open lots across all live KH trades (a trade counts as its largest leg’s lots). A new signal that would exceed this is rejected.</div>' +
            '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
                '<input id="au-kh-cap" type="number" min="0" step="0.5" value="' + autoEsc(String(capVal)) + '" placeholder="e.g. 4" style="' + _AU_INP + ';width:120px">' +
                '<label style="font-size:12px;color:#374151"><input type="checkbox" id="au-kh-cap-on" ' + (capOn ? 'checked' : '') + '> enforce</label>' +
                '<button class="au-btn au-btn-primary" onclick="autoSaveKhCap()">Save cap</button>' +
            '</div>' +
        '</div>' +
        '<div>' +
            '<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:3px">Allowed underlyings' +
                (und ? '' : ' <span style="color:#9ca3af;font-weight:400">— not set (all allowed)</span>') + '</div>' +
            '<div style="font-size:11px;color:#6b7280;margin-bottom:6px">Use the quick-add chips below or type (comma-separated). Checked against your securities master on save to catch typos. A signal on any other underlying is rejected; uncheck “enforce” to allow all.</div>' +
            '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
                '<input id="au-kh-und" value="' + autoEsc(undVals) + '" placeholder="NIFTY, BANKNIFTY" style="' + _AU_INP + ';flex:1;min-width:220px;max-width:380px;text-transform:uppercase">' +
                '<label style="font-size:12px;color:#374151"><input type="checkbox" id="au-kh-und-on" ' + (undOn ? 'checked' : '') + '> enforce</label>' +
                '<button class="au-btn au-btn-primary" onclick="autoSaveKhUnderlyings()">Save underlyings</button>' +
            '</div>' +
            '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
                '<span style="font-size:11px;color:#9ca3af">Quick add:</span>' +
                ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'].map(function (u) { return '<button type="button" onclick="autoAddUnderlying(\'' + u + '\')" style="font-size:11px;padding:2px 9px;border:1px solid #d1d5db;border-radius:12px;background:#f9fafb;cursor:pointer;color:#374151">+ ' + u + '</button>'; }).join('') +
            '</div>' +
        '</div>' +
        '<div style="margin-top:18px">' +
            '<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:3px">Open-position look-back (days)</div>' +
            '<div style="font-size:11px;color:#6b7280;margin-bottom:6px">Days of order history scanned when tallying open KH exposure. KH is intraday, so 3 is plenty (covers a Fri→Mon weekend). Lower = faster check.</div>' +
            '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
                '<input id="au-kh-lookback" type="number" min="1" max="90" value="' + autoEsc(String(lbVal)) + '" style="' + _AU_INP + ';width:120px">' +
                '<button class="au-btn au-btn-primary" onclick="autoSaveKhLookback()">Save look-back</button>' +
            '</div>' +
        '</div>';
}

async function autoSaveKhCap() {
    var v = document.getElementById('au-kh-cap').value;
    var on = document.getElementById('au-kh-cap-on').checked;
    if (v === '' || isNaN(Number(v)) || Number(v) < 0) { alert('Enter a non-negative number of lots (or 0 to block everything).'); return; }
    try {
        var ex = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'max_open_exposure_lots');
        await _auUpsertLimit(ex, AU_KH, 'max_open_exposure_lots', { value: Number(v) }, on, 'reject');
        autoLoadLive();
    } catch (e) { alert('Failed to save cap: ' + (e.message || e)); }
}

// Valid F&O underlyings = distinct active underlyings in securities_nfo, plus the known
// index set (some, e.g. SENSEX/BANKEX, are BSE and may not be in the NSE cache).
function _auValidUnderlyings() {
    var set = {};
    ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX'].forEach(function (u) { set[u] = 1; });
    var nfo = (window.wmsRefData && window.wmsRefData.securitiesNfo) || [];
    nfo.forEach(function (r) { if (r.is_active !== false) { var u = String(r.underlying_symbol || '').toUpperCase(); if (u) set[u] = 1; } });
    return set;
}

// Quick-add chip → append an underlying to the box (deduped, uppercase).
function autoAddUnderlying(u) {
    var inp = document.getElementById('au-kh-und'); if (!inp) return;
    var cur = inp.value.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
    if (cur.indexOf(u) < 0) cur.push(u);
    inp.value = cur.join(', ');
    inp.focus();
}

async function autoSaveKhUnderlyings() {
    var raw = document.getElementById('au-kh-und').value;
    var on  = document.getElementById('au-kh-und-on').checked;
    var vals = raw.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean)
        .filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (on && vals.length === 0) { alert('Add at least one underlying, or uncheck “enforce” to allow all.'); return; }
    // Validate against the securities master — flag anything unrecognised (likely a typo).
    var valid = _auValidUnderlyings();
    var unknown = vals.filter(function (v) { return !valid[v]; });
    if (unknown.length) {
        if (!confirm('These underlyings are NOT in your securities master and look like typos:\n\n   ' + unknown.join(', ') +
            '\n\nA mistyped underlying will silently block its real signals. Fix it, or save anyway?')) return;
    }
    try {
        var ex = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'allowed_underlyings');
        await _auUpsertLimit(ex, AU_KH, 'allowed_underlyings', { values: vals }, on, 'reject');
        autoLoadLive();
    } catch (e) { alert('Failed to save underlyings: ' + (e.message || e)); }
}

// ---- Look-back window (per-strategy) ----
async function autoSaveKhLookback() {
    var v = Number(document.getElementById('au-kh-lookback').value);
    if (!v || v < 1 || v > 90) { alert('Enter a look-back between 1 and 90 days.'); return; }
    try {
        var ex = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'exposure_lookback_days');
        await _auUpsertLimit(ex, AU_KH, 'exposure_lookback_days', { value: v }, true, 'log_only');
        autoLoadLive();
    } catch (e) { alert('Failed to save look-back: ' + (e.message || e)); }
}

// ---- Lot sizes — AUTO-derived from the securities_nfo cache (read-only, self-healing) ----
var _AU_DEFAULT_UNDS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'MIDCPNIFTY'];

// Front-month lot size per underlying, from the in-memory securities_nfo cache (zero extra DB calls).
function _auDeriveLotSizes(unds) {
    var nfo = (window.wmsRefData && window.wmsRefData.securitiesNfo) || [];
    var today = new Date().toISOString().slice(0, 10);
    var map = {};
    (unds || []).forEach(function (u) {
        u = String(u || '').toUpperCase(); if (!u) return;
        var rows = nfo.filter(function (r) { return String(r.underlying_symbol || '').toUpperCase() === u && r.lot_size && r.is_active !== false; });
        if (!rows.length) return;
        var future = rows.filter(function (r) { return r.expiry_date && r.expiry_date >= today; }).sort(function (a, b) { return a.expiry_date < b.expiry_date ? -1 : 1; });
        var pick = future[0] || rows[0];
        if (pick && Number(pick.lot_size) > 0) map[u] = Number(pick.lot_size);
    });
    return map;
}

// Derive lot sizes for the covered underlyings and persist ONLY if they changed (auto-heal each load/save).
async function _auSyncLotSizes() {
    try {
        var undRule = _auFindLimit(AU_KH.source, AU_KH.strategy, null, 'allowed_underlyings');
        var existing = _auFindLimit(null, null, null, 'lot_sizes');
        var existingMap = (existing && existing.limit_value && existing.limit_value.values && typeof existing.limit_value.values === 'object') ? existing.limit_value.values : {};
        var allowed = (undRule && undRule.limit_value && Array.isArray(undRule.limit_value.values)) ? undRule.limit_value.values.map(function (x) { return String(x).toUpperCase(); }) : [];
        var covered = (allowed.length ? allowed.slice() : _AU_DEFAULT_UNDS.slice());
        Object.keys(existingMap).forEach(function (u) { if (covered.indexOf(u) < 0) covered.push(u); });
        var merged = Object.assign({}, existingMap, _auDeriveLotSizes(covered));   // derived wins; keep existing on a cache miss
        if (JSON.stringify(merged) !== JSON.stringify(existingMap)) {
            await _auUpsertLimit(existing, { source: null, strategy: null }, 'lot_sizes', { values: merged }, true, 'log_only');
            var fresh = (await window.supabaseClient.from('wms_live_risk_limits').select('*')).data;
            if (Array.isArray(fresh)) _auLiveLimits = fresh;
        }
    } catch (e) { /* non-fatal — display falls back to whatever is stored */ }
}

function autoRenderLotSizes() {
    var el = document.getElementById('au-live-lotsizes'); if (!el) return;
    var row = _auFindLimit(null, null, null, 'lot_sizes');
    var map = (row && row.limit_value && row.limit_value.values && typeof row.limit_value.values === 'object') ? row.limit_value.values : {};
    var keys = Object.keys(map).sort();
    var body = keys.length
        ? keys.map(function (k) { return '<tr><td style="padding:3px 24px 3px 0">' + autoEsc(k) + '</td><td style="text-align:right">' + autoEsc(String(map[k])) + '</td></tr>'; }).join('')
        : '<tr><td colspan="2" style="color:#9ca3af;padding:4px 0">No lot sizes yet — set an allowed underlying and they auto-fill from the securities master.</td></tr>';
    el.innerHTML =
        '<table style="font-size:12px;border-collapse:collapse">' +
            '<thead><tr style="color:#6b7280;font-size:10px;text-transform:uppercase"><th style="text-align:left;padding-right:24px">Underlying</th><th style="text-align:right">Lot size</th></tr></thead>' +
            '<tbody>' + body + '</tbody>' +
        '</table>' +
        '<div style="font-size:11px;color:#9ca3af;margin-top:8px">Auto-filled from the securities master (front-month contract) — no manual entry. Refreshes when you reopen this tab or run the F&amp;O sync.</div>';
}

// ---- shared upsert: PATCH by id if the rule exists, else POST a new row ----
async function _auUpsertLimit(existing, scope, type, value, enabled, breach) {
    var url, method, body;
    if (existing) {
        url = SUPABASE_URL + '/rest/v1/wms_live_risk_limits?id=eq.' + existing.id;
        method = 'PATCH';
        body = JSON.stringify({ limit_value: value, enabled: enabled, breach_action: breach });
    } else {
        url = SUPABASE_URL + '/rest/v1/wms_live_risk_limits';
        method = 'POST';
        body = JSON.stringify({
            signal_source: scope.source || null,
            strategy_name: scope.strategy || null,
            iba_id: null,
            limit_type: type,
            limit_value: value,
            enabled: enabled,
            breach_action: breach
        });
    }
    var resp = await fetch(url, { method: method, headers: wmsHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }), body: body });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
}
