// writeback-retry.js — keep a placement result from being lost to a Supabase blip.
// ============================================================================
// Owner, 30-Oct-2026. The order server reports each placement / modify / cancel
// result to wms-live-cmd-complete ONCE. On 30-Oct 09:30:14 IST Supabase's
// function runtime answered 503 for ~7s; the report was dropped, the command
// row stayed `claimed` forever and the broker's answer (order id, accepted /
// rejected) never reached the database — 6 such rows 20–30 Oct, all at 503
// moments. Fyers had acted on every one; only OUR record was lost.
//
// The rule this module enforces:
//   • The FIRST attempt is exactly today's call, awaited by the caller — the
//     normal path gets no added latency.
//   • Only a TRANSIENT failure is retried: HTTP 5xx, 429, or no response at all
//     (network error). A 4xx (bad request, HMAC refusal, not found) is a real
//     answer and is NEVER retried.
//   • Retries run in the BACKGROUND on a timer — nothing waits for them, so the
//     pickup loop moves straight on to its next order.
//   • Repeating the same report is safe: cmd-complete's broker_status only
//     moves forward, booking is idempotent, parent-stop updates are idempotent.
//   • Each retry re-signs the request (the caller's `send` builds it fresh).
// Pure + injectable (send, schedule) so it is unit-tested offline
// (writeback-retry.test.mjs).
// ============================================================================

export const WRITEBACK_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000];   // ~37s window

/** Is this error a transient failure worth retrying? */
export function isTransientWritebackError(err) {
  const st = Number(err && err.status);
  if (Number.isFinite(st) && st > 0) return st >= 500 || st === 429;
  return true;   // no HTTP status = no response (network / DNS / reset) -> transient
}

/**
 * Send a writeback; on a transient failure, keep retrying in the background.
 * Returns once the FIRST attempt finishes:
 *   { ok: true }                            first attempt succeeded
 *   { ok: false, retrying: true,  error }   transient — background retries scheduled
 *   { ok: false, retrying: false, error }   permanent (4xx) — not retried
 */
export async function sendWithRetry(send, {
  label = 'writeback',
  delays = WRITEBACK_RETRY_DELAYS_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  log = console,
  onRecovered = () => {},
  onLost = () => {},
} = {}) {
  try {
    await send();
    return { ok: true };
  } catch (err) {
    if (!isTransientWritebackError(err) || !delays.length) {
      return { ok: false, retrying: false, error: err };
    }
    log.warn(`[writeback-retry] ${label}: first attempt failed (${errText(err)}) — retrying in background (${delays.length} more tries)`);
    const tryAt = (i) => schedule(async () => {
      try {
        await send();
        log.log(`[writeback-retry] ${label}: recovered on retry ${i + 1}`);
        onRecovered(i + 1);
      } catch (e) {
        if (isTransientWritebackError(e) && i + 1 < delays.length) { tryAt(i + 1); return; }
        log.error(`[writeback-retry] ${label}: LOST after ${i + 1} retr${i ? 'ies' : 'y'} — ${errText(e)}`);
        onLost(e);
      }
    }, delays[i]);
    tryAt(0);
    return { ok: false, retrying: true, error: err };
  }
}

function errText(e) { return String((e && e.message) || e).slice(0, 200); }
