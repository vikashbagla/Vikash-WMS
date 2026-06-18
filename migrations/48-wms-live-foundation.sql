-- Migration 48 — WMS LIVE foundation: order command queue + kill switch.
--
-- Phase 13 production architecture. Generic enough that any signal source
-- (Katalysthive analyst, Pairs scanner, in-house GS rebuild, manual trades)
-- inserts into the same queue. The wms-live order-placer service on the
-- Droplet polls the queue via an HMAC-authenticated Edge Function, places
-- orders on Fyers from the whitelisted IP, and writes results back.
--
-- Key design choices (recorded so future sessions don't second-guess):
--
-- 1. ONE generic queue (not per-source queues). Source identity lives in
--    signal_source TEXT. Simpler operations + simpler kill-switch semantics.
--
-- 2. JSONB payload (not normalized columns). Each source has different
--    field needs: Katalysthive has multi-leg + SL-protection, Pairs has
--    single-leg, manual is whatever Vikash types. Normalizing would force
--    a schema migration per source. JSONB lets each source carry its own
--    shape; the Droplet's order-placer reads the relevant fields.
--
-- 3. app_state is a SINGLETON (single row, enforced by CHECK constraint
--    on id = 1). Holds the global kill switch + per-source pause list.
--    Edge Functions check before enqueueing. Droplet also checks at claim
--    time as defense-in-depth.
--
-- 4. Status state machine:
--      pending → claimed → placed       (happy path, order accepted by Fyers)
--      pending → claimed → rejected     (Fyers rejected, e.g. margin / IP / market closed)
--      pending → claimed → error        (network/timeout/auth issue; can re-queue)
--      pending → cancelled              (admin cancelled before Droplet claimed)
--
-- 5. claimed_at + claimed_by support the atomic-claim pattern:
--      UPDATE wms_live_commands SET status='claimed', claimed_at=now(), claimed_by=$1
--      WHERE id = (SELECT id FROM wms_live_commands WHERE status='pending'
--                  ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
--      RETURNING *
--    This makes multi-Droplet scaling possible later without a schema change.
--
-- Per WMS-LESSONS §A.9: every new public table needs explicit GRANTs +
-- RLS + updated_at trigger.

-- ============================================================================
-- 1. wms_live_commands — the queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.wms_live_commands (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Provenance
    signal_source     TEXT NOT NULL,                    -- 'katalysthive','pairs','gs_silvermini','gs_goldmini','manual'
    signal_ref        TEXT,                             -- upstream identifier — analyst's trade_id, auto_signals.id, free-text for manual
    strategy_name     TEXT,                             -- optional: matches auto_strategies.name when applicable
    leg_index         INT  NOT NULL DEFAULT 0,          -- 0-based within a multi-leg signal (Katalysthive can send 2+ legs per signal)

    -- Order spec — generic JSONB so each source can carry its own shape
    -- For Fyers /api/v3/orders/sync the payload SHOULD have these fields
    -- by the time the Droplet picks it up (Edge Function normalizes if needed):
    --   symbol         TEXT       e.g., 'MCX:SILVERM26JUNFUT' or 'NSE:NIFTY23JUN23850PE'
    --   side           INT        1=BUY, -1=SELL (Fyers v3 spec)
    --   qty            INT        contract count
    --   type           INT        1=LIMIT, 2=MARKET, 3=STOP, 4=STOPLIMIT
    --   productType    TEXT       'MARGIN' for F&O, 'CNC' for delivery equity, 'INTRADAY' for MIS
    --   limitPrice     NUMERIC    only for type=1 or 4
    --   stopPrice      NUMERIC    only for type=3 or 4
    --   validity       TEXT       'DAY' or 'IOC'
    --   offlineOrder   BOOLEAN    true = AMO, false = NOW
    -- Plus source-specific fields like sl_protection, hedge, leg_id (Katalysthive).
    payload           JSONB NOT NULL,

    -- State machine
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','claimed','placed','rejected','error','cancelled')),

    -- Claim — set when the Droplet's wms-live service takes ownership
    claimed_at        TIMESTAMPTZ,
    claimed_by        TEXT,                             -- e.g., 'wms-live-1' (Droplet hostname)

    -- Placement result — set when Fyers responds
    placed_at         TIMESTAMPTZ,
    fyers_order_id    TEXT,                             -- Fyers order ID (norenordno_...)
    fyers_response    JSONB,                            -- full raw response for audit
    error_code        TEXT,                             -- our normalized code: 'FYERS_REJECT','TIMEOUT','HMAC_FAIL',...
    error_message     TEXT,

    -- Retry tracking
    attempts          INT NOT NULL DEFAULT 0,

    -- Standard audit
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.wms_live_commands IS 'Phase 13 order command queue. Any signal source inserts here; the Droplet wms-live service polls + places orders on Fyers from the whitelisted IP.';
COMMENT ON COLUMN public.wms_live_commands.signal_source IS 'Origin of the command. Affects kill-switch + audit. Values: katalysthive, pairs, gs_silvermini, gs_goldmini, manual.';
COMMENT ON COLUMN public.wms_live_commands.payload IS 'Fyers /api/v3/orders/sync body (symbol, side, qty, type, productType, limitPrice, stopPrice, validity, offlineOrder) + source-specific fields. JSONB so sources can extend without migration.';
COMMENT ON COLUMN public.wms_live_commands.status IS 'State machine: pending → claimed → placed | rejected | error | cancelled. Transitions enforced in app code, not DB triggers.';

-- Indexes — covering the hot queries
-- Poll query: WHERE status='pending' ORDER BY created_at ASC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_wms_live_commands_pending
    ON public.wms_live_commands (created_at ASC)
    WHERE status = 'pending';

-- Audit queries by source
CREATE INDEX IF NOT EXISTS idx_wms_live_commands_source_created
    ON public.wms_live_commands (signal_source, created_at DESC);

-- Lookup by Fyers order id (for callbacks / reconciliation)
CREATE INDEX IF NOT EXISTS idx_wms_live_commands_fyers_order_id
    ON public.wms_live_commands (fyers_order_id)
    WHERE fyers_order_id IS NOT NULL;

-- updated_at trigger (per WMS-LESSONS §A.9.1)
DROP TRIGGER IF EXISTS trg_wms_live_commands_updated_at ON public.wms_live_commands;
CREATE TRIGGER trg_wms_live_commands_updated_at
    BEFORE UPDATE ON public.wms_live_commands
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 2. app_state — singleton config (kill switch + paused sources)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.app_state (
    id                INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- enforces single row
    kill_switch       BOOLEAN NOT NULL DEFAULT false,
    paused_sources    TEXT[]  NOT NULL DEFAULT '{}',              -- pause specific sources, e.g., ARRAY['katalysthive']
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by        TEXT,                                       -- 'vikash@email', 'edge:analyst-webhook', etc.
    updated_reason    TEXT
);

COMMENT ON TABLE  public.app_state IS 'Singleton row holding global trading kill switch + per-source pause list. Checked by every signal source before enqueueing AND by the Droplet at claim time.';
COMMENT ON COLUMN public.app_state.kill_switch IS 'When true, NO orders are placed regardless of source. Toggling this is the emergency stop.';
COMMENT ON COLUMN public.app_state.paused_sources IS 'Per-source pause. Element values match wms_live_commands.signal_source.';

-- Seed the singleton row
INSERT INTO public.app_state (id, kill_switch, paused_sources, updated_by, updated_reason)
VALUES (1, false, '{}', 'migration_48', 'Initial seed')
ON CONFLICT (id) DO NOTHING;

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_app_state_updated_at ON public.app_state;
CREATE TRIGGER trg_app_state_updated_at
    BEFORE UPDATE ON public.app_state
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 3. RLS — owner-only on both tables (per WMS-LESSONS §A.10)
-- ============================================================================

ALTER TABLE public.wms_live_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_state         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_all ON public.wms_live_commands;
CREATE POLICY owner_all ON public.wms_live_commands
    FOR ALL
    USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

DROP POLICY IF EXISTS owner_all ON public.app_state;
CREATE POLICY owner_all ON public.app_state
    FOR ALL
    USING (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'vikash.bagla@gmail.com');

-- ============================================================================
-- 4. GRANTs — per WMS-LESSONS §A.9.1
-- ============================================================================

-- service_role bypasses RLS by design; explicit grants are still required so
-- PostgREST surfaces the tables to the Edge Function REST calls.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_live_commands TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_state         TO service_role;

-- authenticated role (Vikash via the browser app) — RLS still scopes
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_live_commands TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_state         TO authenticated;

-- anon role: NO access. The Droplet talks via HMAC-authenticated Edge Functions
-- that internally use service_role, never via direct REST under anon.

-- ============================================================================
-- 5. Verification queries (uncomment + run manually to confirm)
-- ============================================================================

-- SELECT id, signal_source, status, claimed_at, fyers_order_id
-- FROM public.wms_live_commands
-- ORDER BY created_at DESC LIMIT 10;

-- SELECT id, kill_switch, paused_sources, updated_at, updated_by, updated_reason
-- FROM public.app_state;
