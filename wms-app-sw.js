// WMS iPhone app — keeps the screen files on the phone (WMS iPhone App Plan, step 2.3, option B, 21-Nov-2026).
//
// WHAT IT DOES
//  • Registered ONLY inside the WMS iPhone app (see wms-app-sw-register.js). Desktop browsers, Safari and
//    the Safari Home Screen app never run it.
//  • Every screen file (our .html / .js / .css / images, plus the pinned CDN libraries) is kept on the
//    phone after the first open. The app then opens from that copy — no waiting on the network.
//  • A few seconds after each opening the page asks this worker to check the website for newer files.
//    All changed files are downloaded into a NEW copy; only when every file downloaded correctly is the
//    new copy switched in, all at once (so the app never mixes old and new files). The new screens are
//    used from the NEXT opening.
//  • Data (Supabase), live prices and sign-in are NEVER cached here — they always go to the network.
//
// KILL SWITCH: wms-app-sw-register.js removes this worker and its copies when
// localStorage.wms_app_sw === 'off'. To switch it off for everyone, publish a version of this file whose
// SW_ENABLED is false: on its next check the app removes its copies and goes back to plain network loading.

const SW_ENABLED = true;
const SW_VERSION = '2026-11-21.1';
const PREFIX = 'wms-screens-';                 // file copies: wms-screens-<timestamp>
const META = 'wms-screens-meta';               // tiny cache: which copy is active + last check time
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'cdn.sheetjs.com'];
const CHECK_EVERY_MS = 5 * 60 * 1000;          // check for newer files at most every 5 minutes
const PARALLEL = 6;

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
    e.waitUntil((async function () {
        if (!SW_ENABLED) { await removeEverything(); await self.registration.unregister(); return; }
        await self.clients.claim();
    })());
});

// ---- which requests are kept on the phone ------------------------------------------------------------
function isCacheable(req) {
    if (!SW_ENABLED || req.method !== 'GET') return false;
    var u = new URL(req.url);
    if (u.origin === self.location.origin) return !/wms-app-sw(-register)?\.js$/.test(u.pathname);
    return CDN_HOSTS.indexOf(u.hostname) !== -1;
}
// Our own files are stamped ?v=<deploy> by app.html; the stamp is dropped from the storage key so a new
// deploy finds the (refreshed) copy instead of downloading everything again. Other query parts are kept.
function keyFor(url) {
    var u = new URL(url);
    u.hash = '';
    if (u.origin === self.location.origin) u.searchParams.delete('v');
    return u.toString();
}

// ---- active copy bookkeeping -------------------------------------------------------------------------
async function readMeta() {
    var c = await caches.open(META);
    var r = await c.match('/__wms_meta');
    return r ? r.json() : { active: null, checkedAt: 0 };
}
async function writeMeta(m) {
    var c = await caches.open(META);
    await c.put('/__wms_meta', new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/json' } }));
}
async function activeCache() {
    var m = await readMeta();
    if (!m.active) { m.active = PREFIX + Date.now(); await writeMeta(m); }
    return caches.open(m.active);
}
async function removeEverything() {
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0; }).map(function (k) { return caches.delete(k); }));
}

// A response that was redirected (e.g. Cloudflare serving app.html as /app) cannot be handed back to a
// page navigation as-is; this makes a clean copy with the same body and headers.
async function cleanCopy(res) {
    if (!res.redirected) return res;
    var body = await res.blob();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
function storable(res) { return res && (res.ok || res.type === 'opaque'); }

// ---- serving -----------------------------------------------------------------------------------------
self.addEventListener('fetch', function (e) {
    if (!isCacheable(e.request)) return;           // data, prices, sign-in: straight to the network
    e.respondWith(serve(e.request));
});

async function serve(req) {
    var cache = await activeCache();
    var key = keyFor(req.url);
    var hit = await cache.match(key, { ignoreVary: true });
    if (hit) return hit;
    // Not on the phone yet: fetch it, keep a copy, hand it back.
    var res = await fetch(req.mode === 'navigate' ? new Request(req.url, { credentials: 'same-origin' }) : req);
    var copy = await cleanCopy(res);
    if (storable(copy)) { try { await cache.put(key, copy.clone()); } catch (err) { /* storage full: still serve */ } }
    return copy;
}

// ---- checking the website for newer files (all-or-nothing swap) --------------------------------------
self.addEventListener('message', function (e) {
    if (e.data === 'wms-check-for-updates') e.waitUntil(checkForUpdates(false));
    if (e.data === 'wms-check-for-updates-now') e.waitUntil(checkForUpdates(true));
});

var checking = null;
function checkForUpdates(force) {
    if (!checking) checking = doCheck(force).catch(function (err) { console.warn('WMS app: update check failed, keeping the current files', err); }).finally(function () { checking = null; });
    return checking;
}

async function sameBody(a, b) {
    if (!a || !b) return false;
    if (a.type === 'opaque' || b.type === 'opaque') return true;     // CDN libraries are version-pinned
    var x = new Uint8Array(await a.clone().arrayBuffer()), y = new Uint8Array(await b.clone().arrayBuffer());
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
}

async function doCheck(force) {
    var meta = await readMeta();
    if (!force && Date.now() - (meta.checkedAt || 0) < CHECK_EVERY_MS) return;
    if (!meta.active) return;
    var current = await caches.open(meta.active);
    var keys = await current.keys();
    if (!keys.length) return;
    var nextName = PREFIX + Date.now();
    var next = await caches.open(nextName);
    var changed = 0;
    try {
        for (var i = 0; i < keys.length; i += PARALLEL) {
            await Promise.all(keys.slice(i, i + PARALLEL).map(async function (k) {
                var sameOrigin = new URL(k.url).origin === self.location.origin;
                var res = await fetch(k.url, sameOrigin ? { cache: 'no-cache', credentials: 'same-origin' } : { mode: 'no-cors' });
                var copy = await cleanCopy(res);
                if (!storable(copy)) throw new Error('could not download ' + k.url + ' (' + copy.status + ')');
                var old = await current.match(k);
                if (!(await sameBody(old, copy))) changed++;
                await next.put(k, copy);
            }));
        }
    } catch (err) {
        await caches.delete(nextName);          // keep the current copy untouched
        throw err;
    }
    if (!changed) {
        await caches.delete(nextName);
        meta.checkedAt = Date.now();
        await writeMeta(meta);
        return;
    }
    var oldName = meta.active;
    meta.active = nextName;
    meta.checkedAt = Date.now();
    meta.updatedAt = Date.now();
    meta.changedFiles = changed;
    await writeMeta(meta);                       // switch: from now on every request reads the new copy
    await caches.delete(oldName);
    var clients = await self.clients.matchAll();
    clients.forEach(function (c) { c.postMessage({ type: 'wms-screens-updated', changed: changed, version: SW_VERSION }); });
}
