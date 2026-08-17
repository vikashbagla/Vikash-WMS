// ============================================================================
// wms-acct-worklist.js — the incremental posting worklist (NOT the engine).
//
// Pure/UMD, no DOM/fetch. This is the wiring the plan (FY-CLOSE-PLAN D10/D17/D18,
// Impl Spec §16) specifies: posting is NEW + CHANGED only, never wipe-and-repost.
// It does NOT touch the frozen posting engine (accounting-engine.js) — it decides
// which freshly-derived vouchers to POST, which to REPLACE, and which to leave.
//
// Both the Rebuild-as-EF-call and the nightly cron call acctDiffVouchers with:
//   fresh    = vouchers the engine just derived for the book, each {key, sig, voucher}
//   existing = the book's live (non-cancelled) auto-vouchers,   each {key, sig, id}
//   opts.closedUpto = the book's books_closed_upto ('YYYY-MM-DD' or null)
//   opts.dateOf(v)  = returns a fresh voucher's date (for the closed-period test)
//
// `key`  = the idempotency key: source_transaction_id for a trade voucher (the
//          existing uq_acct_vouchers_source guarantees one per trade), or a
//          stable statement key for a ledger_entry voucher.
// `sig`  = a canonical, order-independent signature of the voucher's resolved
//          lines (ledger_id|debit|credit), so "changed" means the accounting
//          actually changed — the field-level second step of D17, done on the
//          derived voucher rather than re-reading raw trade fields.
//
// Returns { toPost, toReplace, unchanged, orphans, closedBlocked }:
//   toPost        — fresh vouchers with no live existing voucher, in an OPEN
//                   period → post new.
//   toReplace     — [{ oldId, fresh }] existing voucher whose sig changed AND the
//                   voucher is in an OPEN period → cancel old, post fresh.
//   unchanged     — sig identical → do nothing.
//   skippedClosed — fresh voucher in a CLOSED period with no existing voucher →
//                   do NOT post. The closed period's net effect is carried by the
//                   book's OPENING BALANCE (investments at cost, capital, cash…),
//                   so its individual trades are never posted. This is what makes
//                   "close the book to 31-Mar" actually bound the engine to the
//                   open period — without it, brand-new closed-period trades were
//                   posted and double-counted the opening balance.
//   closedBlocked — sig changed but the voucher is in a CLOSED period → do NOT
//                   edit; caller logs an acct_exceptions alert (D12).
//   orphans       — live existing vouchers with no fresh counterpart (source
//                   trade gone / no longer eligible) → caller alerts (D-delete).
// ============================================================================
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) { for (var k in api) { if (api.hasOwnProperty(k)) root[k] = api[k]; } }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {

    function r2(x) { return Math.round((parseFloat(x) || 0) * 100) / 100; }

    // Canonical signature of a voucher's RESOLVED lines (ledger_id + amounts),
    // order-independent so a re-ordered but identical voucher is "unchanged".
    // `lines` = [{ ledger_id, debit_amount|debit, credit_amount|credit }].
    function acctVoucherSig(lines) {
        return (lines || []).map(function (l) {
            var d = r2(l.debit_amount !== undefined ? l.debit_amount : l.debit);
            var c = r2(l.credit_amount !== undefined ? l.credit_amount : l.credit);
            return String(l.ledger_id) + '|' + d + '|' + c;
        }).sort().join(';');
    }

    function inClosedPeriod(dateYmd, closedUpto) {
        if (!closedUpto || !dateYmd) return false;
        return String(dateYmd).slice(0, 10) <= String(closedUpto).slice(0, 10);
    }

    // fresh/existing items: { key, sig, voucher?/id?, date? }
    function acctDiffVouchers(fresh, existing, opts) {
        opts = opts || {};
        var closedUpto = opts.closedUpto || null;
        var exByKey = {};
        (existing || []).forEach(function (e) { exByKey[String(e.key)] = e; });
        var seen = {};
        var out = { toPost: [], toReplace: [], unchanged: [], skippedClosed: [], closedBlocked: [], orphans: [] };

        (fresh || []).forEach(function (f) {
            var key = String(f.key);
            seen[key] = true;
            var e = exByKey[key];
            var date = (opts.dateOf ? opts.dateOf(f) : f.date);
            if (!e) {                                             // NEW
                // A brand-new trade in a CLOSED period is carried by the opening
                // balance, not posted individually (see header). Skip it.
                if (inClosedPeriod(date, closedUpto)) out.skippedClosed.push(f);
                else out.toPost.push(f);
                return;
            }
            if (e.sig === f.sig) { out.unchanged.push(f); return; } // UNCHANGED
            // CHANGED — open period edits; closed period is logged, never edited (D12)
            if (inClosedPeriod(date, closedUpto)) out.closedBlocked.push({ oldId: e.id, fresh: f });
            else out.toReplace.push({ oldId: e.id, fresh: f });
        });

        (existing || []).forEach(function (e) {
            if (!seen[String(e.key)]) out.orphans.push(e);         // live voucher, no fresh source → alert
        });
        return out;
    }

    return { acctVoucherSig: acctVoucherSig, acctDiffVouchers: acctDiffVouchers, inClosedPeriod: inClosedPeriod };
});
