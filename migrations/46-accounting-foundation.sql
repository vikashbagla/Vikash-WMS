-- Migration 46 — Accounting module foundation (Phase 1).
--
-- Creates the four core accounting tables + a flattened read view + the
-- atomic voucher-posting RPC, seeds the group hierarchy and system ledgers,
-- and adds the per-book accounting columns to the existing investors table.
--
-- Design authority: WMS_Accounting_Module_Plan.md v2.2 (owner-approved).
-- Namespace authority: WMS-LESSONS §A.6 — tables are acct_*, JS will be ac*.
--
-- KEY DESIGN POINTS (see plan for full rationale):
--   * GLOBAL ledger catalogue (acct_ledgers) shared by all books. A ledger is
--     "in" a book only if a voucher in that book references it (no mapping
--     table). is_global=true by default; is_global=false + scope_investor_id
--     restricts a ledger to one book.
--   * GROUP hierarchy (acct_groups): nature lives only on the five fixed roots;
--     nested groups inherit it from their root ancestor. No nature/normal_balance
--     columns — display direction follows the balance sign.
--   * VOUCHER header carries stored totals (written atomically with the lines by
--     the RPC). The portfolio action is encoded in voucher_type itself
--     (PMS-BUY, PMS-SELL, …); OPENING_BALANCE is a type (no is_opening flag).
--   * NO dev twins. These tables are brand new and nothing reads/writes them
--     yet, so there is a single set (owner directive 2026-06-13). The dev SITE
--     uses this same set; only code is branch-separated.
--
-- GRANTs + RLS per §A.9.1 / §A.10.1 (authenticated + service_role; owner-only
-- via RLS; never anon/public). View uses security_invoker=on per §A.10.2.
--
-- Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE / WHERE NOT EXISTS /
-- ON CONFLICT throughout. Run once in Supabase SQL Editor.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1.  acct_groups — group hierarchy (global)
-- ============================================================================
-- The five roots (parent_group_id IS NULL) define the natures: Assets,
-- Liabilities, Income, Expenses, Capital. Every nested group inherits its
-- nature by walking parent_group_id to the root.

CREATE TABLE IF NOT EXISTS public.acct_groups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    parent_group_id UUID REFERENCES public.acct_groups(id),
    is_system       BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.acct_groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.acct_groups TO service_role;

ALTER TABLE public.acct_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.acct_groups;
CREATE POLICY owner_all ON public.acct_groups
    FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- ============================================================================
-- 2.  acct_ledgers — global ledger catalogue
-- ============================================================================
-- ledger_kind is a SOFT tag (no CHECK yet) used to help auto-posting + the UI.
-- is_global=true: available to all books. is_global=false: restricted to the
-- single book named in scope_investor_id (e.g. a specific bank account, a
-- client current account). Opening balance + balance direction are NOT stored
-- here — they are book-specific and come from the opening voucher / history.

CREATE TABLE IF NOT EXISTS public.acct_ledgers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              VARCHAR(200) NOT NULL UNIQUE,
    group_id          UUID NOT NULL REFERENCES public.acct_groups(id),
    ledger_kind       VARCHAR(30) NOT NULL DEFAULT 'GENERAL',
    is_global         BOOLEAN NOT NULL DEFAULT true,
    scope_investor_id UUID REFERENCES public.investors(id),
    is_system         BOOLEAN NOT NULL DEFAULT false,
    is_active         BOOLEAN NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_acct_ledgers_group ON public.acct_ledgers (group_id);
CREATE INDEX IF NOT EXISTS idx_acct_ledgers_scope ON public.acct_ledgers (scope_investor_id)
    WHERE scope_investor_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.acct_ledgers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.acct_ledgers TO service_role;

ALTER TABLE public.acct_ledgers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.acct_ledgers;
CREATE POLICY owner_all ON public.acct_ledgers
    FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- ============================================================================
-- 3.  acct_vouchers — voucher header
-- ============================================================================
-- investor_id = book owner (the PARENT for a client's auto-voucher).
-- voucher_type holds the granular value (JOURNAL / RECEIPT / PAYMENT / CONTRA /
-- OPENING_BALANCE / PMS-BUY / PMS-SELL / …). Totals stored, written atomically
-- with lines by acct_post_voucher. reversal_voucher_id non-null on an ORIGINAL
-- ⇒ it has been reversed (no separate is_reversed flag).

CREATE TABLE IF NOT EXISTS public.acct_vouchers (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investor_id           UUID NOT NULL REFERENCES public.investors(id),
    voucher_number        VARCHAR(20) NOT NULL,
    voucher_type          VARCHAR(30) NOT NULL,
    voucher_date          DATE NOT NULL,
    narration             TEXT,
    total_debit           DECIMAL(15,2) NOT NULL DEFAULT 0,
    total_credit          DECIMAL(15,2) NOT NULL DEFAULT 0,
    is_auto               BOOLEAN NOT NULL DEFAULT false,
    source_transaction_id UUID REFERENCES public.transactions(id),
    reversal_voucher_id   UUID REFERENCES public.acct_vouchers(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: at most one auto-voucher per source transaction.
CREATE UNIQUE INDEX IF NOT EXISTS uq_acct_vouchers_source
    ON public.acct_vouchers (source_transaction_id)
    WHERE source_transaction_id IS NOT NULL;

-- One voucher number per book.
CREATE UNIQUE INDEX IF NOT EXISTS uq_acct_vouchers_book_number
    ON public.acct_vouchers (investor_id, voucher_number);

CREATE INDEX IF NOT EXISTS idx_acct_vouchers_book_date
    ON public.acct_vouchers (investor_id, voucher_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.acct_vouchers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.acct_vouchers TO service_role;

ALTER TABLE public.acct_vouchers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.acct_vouchers;
CREATE POLICY owner_all ON public.acct_vouchers
    FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- ============================================================================
-- 4.  acct_voucher_lines — voucher lines
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.acct_voucher_lines (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voucher_id    UUID NOT NULL REFERENCES public.acct_vouchers(id) ON DELETE CASCADE,
    ledger_id     UUID NOT NULL REFERENCES public.acct_ledgers(id),
    debit_amount  DECIMAL(15,2) NOT NULL DEFAULT 0,
    credit_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    narration     TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    CHECK (debit_amount >= 0 AND credit_amount >= 0
           AND (debit_amount = 0 OR credit_amount = 0))
);

CREATE INDEX IF NOT EXISTS idx_acct_voucher_lines_voucher
    ON public.acct_voucher_lines (voucher_id);
CREATE INDEX IF NOT EXISTS idx_acct_voucher_lines_ledger
    ON public.acct_voucher_lines (ledger_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.acct_voucher_lines TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.acct_voucher_lines TO service_role;

ALTER TABLE public.acct_voucher_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.acct_voucher_lines;
CREATE POLICY owner_all ON public.acct_voucher_lines
    FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- ============================================================================
-- 5.  acct_voucher_full — flattened read view (header + lines + ledger + group)
-- ============================================================================
-- security_invoker=on so the caller's RLS on the base tables applies (§A.10.2).

CREATE OR REPLACE VIEW public.acct_voucher_full AS
SELECT
    v.id                    AS voucher_id,
    v.investor_id,
    v.voucher_number,
    v.voucher_type,
    v.voucher_date,
    v.narration             AS voucher_narration,
    v.total_debit,
    v.total_credit,
    v.is_auto,
    v.source_transaction_id,
    v.reversal_voucher_id,
    l.id                    AS line_id,
    l.ledger_id,
    l.debit_amount,
    l.credit_amount,
    COALESCE(NULLIF(l.narration, ''), v.narration) AS line_narration,
    l.sort_order,
    lg.name                 AS ledger_name,
    lg.ledger_kind,
    lg.group_id,
    g.name                  AS group_name,
    g.parent_group_id
FROM public.acct_vouchers v
JOIN public.acct_voucher_lines l ON l.voucher_id = v.id
JOIN public.acct_ledgers lg      ON lg.id = l.ledger_id
LEFT JOIN public.acct_groups g   ON g.id = lg.group_id;

ALTER VIEW public.acct_voucher_full SET (security_invoker = on);

GRANT SELECT ON public.acct_voucher_full TO authenticated;
GRANT SELECT ON public.acct_voucher_full TO service_role;

-- ============================================================================
-- 6.  acct_post_voucher(p_header jsonb, p_lines jsonb) — atomic post
-- ============================================================================
-- Validates Σdebit = Σcredit (and > 0), computes totals, derives the per-book /
-- per-family / per-FY voucher number, inserts header + all lines in ONE call,
-- and returns { voucher_id, voucher_number, total_debit, total_credit }.
-- SECURITY INVOKER so RLS on the base tables applies to the inserts.
--
-- p_header keys: investor_id, voucher_type, voucher_date, narration,
--                is_auto?, source_transaction_id?, reversal_voucher_id?
-- p_lines: JSON array of { ledger_id, debit_amount, credit_amount,
--                          narration?, sort_order? }

CREATE OR REPLACE FUNCTION public.acct_post_voucher(p_header jsonb, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_investor       uuid    := (p_header->>'investor_id')::uuid;
    v_type           text    := p_header->>'voucher_type';
    v_date           date    := (p_header->>'voucher_date')::date;
    v_narration      text    := p_header->>'narration';
    v_is_auto        boolean := COALESCE((p_header->>'is_auto')::boolean, false);
    v_src            uuid    := NULLIF(p_header->>'source_transaction_id','')::uuid;
    v_rev            uuid    := NULLIF(p_header->>'reversal_voucher_id','')::uuid;
    v_total_debit    numeric := 0;
    v_total_credit   numeric := 0;
    v_family         text;
    v_fy_start_month int;
    v_fy_start       date;
    v_seq            int;
    v_number         text;
    v_voucher_id     uuid;
    v_line           jsonb;
BEGIN
    IF v_investor IS NULL THEN
        RAISE EXCEPTION 'acct_post_voucher: investor_id is required';
    END IF;
    IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
        RAISE EXCEPTION 'acct_post_voucher: at least two lines are required';
    END IF;

    -- totals
    SELECT COALESCE(SUM((l->>'debit_amount')::numeric), 0),
           COALESCE(SUM((l->>'credit_amount')::numeric), 0)
      INTO v_total_debit, v_total_credit
      FROM jsonb_array_elements(p_lines) AS l;

    IF round(v_total_debit, 2) <> round(v_total_credit, 2) THEN
        RAISE EXCEPTION 'acct_post_voucher: not balanced (debit % <> credit %)',
            v_total_debit, v_total_credit;
    END IF;
    IF round(v_total_debit, 2) = 0 THEN
        RAISE EXCEPTION 'acct_post_voucher: voucher total is zero';
    END IF;

    -- family prefix for the voucher number
    v_family := CASE
        WHEN v_type = 'JOURNAL'         THEN 'JV'
        WHEN v_type = 'RECEIPT'         THEN 'RV'
        WHEN v_type = 'PAYMENT'         THEN 'PV'
        WHEN v_type = 'CONTRA'          THEN 'CV'
        WHEN v_type = 'OPENING_BALANCE' THEN 'OB'
        WHEN v_type LIKE 'PMS%'         THEN 'PMS'
        ELSE 'JV'
    END;

    -- FY window from the book's financial_year_start (default April = 4)
    SELECT COALESCE(financial_year_start, 4) INTO v_fy_start_month
      FROM public.investors WHERE id = v_investor;
    IF v_fy_start_month IS NULL THEN v_fy_start_month := 4; END IF;

    v_fy_start := make_date(
        CASE WHEN EXTRACT(MONTH FROM v_date)::int >= v_fy_start_month
             THEN EXTRACT(YEAR FROM v_date)::int
             ELSE EXTRACT(YEAR FROM v_date)::int - 1 END,
        v_fy_start_month, 1);

    -- next sequence within (book, family, FY)
    SELECT COUNT(*) + 1 INTO v_seq
      FROM public.acct_vouchers
     WHERE investor_id = v_investor
       AND voucher_number LIKE v_family || '-%'
       AND voucher_date >= v_fy_start
       AND voucher_date < (v_fy_start + INTERVAL '1 year');

    v_number := v_family || '-' || LPAD(v_seq::text, 4, '0');

    INSERT INTO public.acct_vouchers (
        investor_id, voucher_number, voucher_type, voucher_date, narration,
        total_debit, total_credit, is_auto, source_transaction_id, reversal_voucher_id)
    VALUES (
        v_investor, v_number, v_type, v_date, v_narration,
        round(v_total_debit, 2), round(v_total_credit, 2), v_is_auto, v_src, v_rev)
    RETURNING id INTO v_voucher_id;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
        INSERT INTO public.acct_voucher_lines (
            voucher_id, ledger_id, debit_amount, credit_amount, narration, sort_order)
        VALUES (
            v_voucher_id,
            (v_line->>'ledger_id')::uuid,
            round(COALESCE((v_line->>'debit_amount')::numeric, 0), 2),
            round(COALESCE((v_line->>'credit_amount')::numeric, 0), 2),
            NULLIF(v_line->>'narration', ''),
            COALESCE((v_line->>'sort_order')::int, 0));
    END LOOP;

    RETURN jsonb_build_object(
        'voucher_id',     v_voucher_id,
        'voucher_number', v_number,
        'total_debit',    round(v_total_debit, 2),
        'total_credit',   round(v_total_credit, 2));
END $$;

GRANT EXECUTE ON FUNCTION public.acct_post_voucher(jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acct_post_voucher(jsonb, jsonb) TO service_role;

-- ============================================================================
-- 7.  investors — per-book accounting columns (additive; shared master data)
-- ============================================================================
-- accounting_enabled = maintains own books. book_parent_id set ⇒ this investor
-- is a CLIENT of that parent (which must be accounting_enabled). post_fno gates
-- F&O posting. A client cannot also have own books (CHECK).

ALTER TABLE public.investors ADD COLUMN IF NOT EXISTS accounting_enabled BOOLEAN DEFAULT false;
ALTER TABLE public.investors ADD COLUMN IF NOT EXISTS book_parent_id UUID REFERENCES public.investors(id);
ALTER TABLE public.investors ADD COLUMN IF NOT EXISTS post_fno BOOLEAN DEFAULT true;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'investors_book_role_chk') THEN
        ALTER TABLE public.investors ADD CONSTRAINT investors_book_role_chk
            CHECK (NOT (accounting_enabled = true AND book_parent_id IS NOT NULL));
    END IF;
END $$;

-- ============================================================================
-- 8.  Seed — group hierarchy (idempotent by name)
-- ============================================================================

-- 8a. roots (parent_group_id IS NULL)
INSERT INTO public.acct_groups (name, parent_group_id, is_system)
SELECT x.name, NULL, true
FROM (VALUES ('Assets'),('Liabilities'),('Income'),('Expenses'),('Capital')) AS x(name)
WHERE NOT EXISTS (
    SELECT 1 FROM public.acct_groups g WHERE g.name = x.name AND g.parent_group_id IS NULL);

-- 8b. sub-groups (parent referenced by root name)
INSERT INTO public.acct_groups (name, parent_group_id, is_system)
SELECT s.name,
       (SELECT id FROM public.acct_groups WHERE name = s.parent AND parent_group_id IS NULL),
       true
FROM (VALUES
    ('Bank Accounts',         'Assets'),
    ('Broker Accounts',       'Assets'),
    ('Investments',           'Assets'),
    ('Current Assets',        'Assets'),
    ('Client Accounts',       'Liabilities'),
    ('Current Liabilities',   'Liabilities'),
    ('Capital Gains',         'Income'),
    ('Trading & Other Income','Income'),
    ('F&O Income',            'Income'),
    ('Transaction Charges',   'Expenses'),
    ('F&O Expenses',          'Expenses')
) AS s(name, parent)
WHERE NOT EXISTS (SELECT 1 FROM public.acct_groups g WHERE g.name = s.name);

-- ============================================================================
-- 9.  Seed — system ledgers (idempotent by unique name)
-- ============================================================================

INSERT INTO public.acct_ledgers (name, group_id, ledger_kind, is_global, is_system)
SELECT d.name,
       (SELECT id FROM public.acct_groups WHERE name = d.grp ORDER BY parent_group_id NULLS LAST LIMIT 1),
       d.kind, true, true
FROM (VALUES
    ('TDS Receivable',              'Current Assets',         'TDS_RECEIVABLE'),
    ('PMS Adjustment',              'Current Assets',         'PMS_ADJUSTMENT'),
    ('Realised Capital Gains (ST)', 'Capital Gains',          'REALISED_GAIN'),
    ('Realised Capital Gains (LT)', 'Capital Gains',          'REALISED_GAIN'),
    ('Dividend Income',             'Trading & Other Income', 'INCOME'),
    ('Interest Income',             'Trading & Other Income', 'INCOME'),
    ('Other Income',                'Trading & Other Income', 'INCOME'),
    ('F&O Trading Profit',          'F&O Income',             'FNO_PL'),
    ('STT',                         'Transaction Charges',    'STT_EXPENSE'),
    ('F&O Trading Loss',            'F&O Expenses',           'FNO_PL'),
    ('Capital Account',             'Capital',                'CAPITAL'),
    ('Drawings',                    'Capital',                'CAPITAL'),
    ('Retained Earnings',           'Capital',                'RETAINED_EARNINGS'),
    ('Current Year P&L',            'Capital',                'CAPITAL')
) AS d(name, grp, kind)
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- 10. Sanity report
-- ============================================================================

SELECT 'acct_groups'        AS obj, count(*) AS rows FROM public.acct_groups
UNION ALL SELECT 'acct_ledgers',       count(*) FROM public.acct_ledgers
UNION ALL SELECT 'acct_vouchers',      count(*) FROM public.acct_vouchers
UNION ALL SELECT 'acct_voucher_lines', count(*) FROM public.acct_voucher_lines;

COMMIT;
