-- Migration 47 — Fix acct_post_voucher voucher numbering across financial years.
--
-- BUG: migration 46's acct_post_voucher reset the sequence each FY and produced
-- a number like 'PMS-0001' with no FY component. The UNIQUE index
-- uq_acct_vouchers_book_number is on (investor_id, voucher_number) across ALL
-- years, so 'PMS-0001' in FY2024-25 collided with 'PMS-0001' in FY2025-26
-- (error 23505). Surfaced when rebuilding a book whose trades span multiple FYs.
--
-- FIX: embed the FY label in the number -> 'PMS-2425-0001'. Globally unique per
-- book, still resets per FY (the NNNN part), and reads more clearly.
--
-- CREATE OR REPLACE only — no schema/data change. Safe to re-run. Run once in
-- Supabase SQL Editor. (Existing 'PMS-0001'-style rows from testing are AUTO
-- vouchers and get cleared + regenerated on the next "Rebuild from trades".)
-- ============================================================================

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
    v_fy_start_year  int;
    v_fy_label       text;
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

    v_family := CASE
        WHEN v_type = 'JOURNAL'         THEN 'JV'
        WHEN v_type = 'RECEIPT'         THEN 'RV'
        WHEN v_type = 'PAYMENT'         THEN 'PV'
        WHEN v_type = 'CONTRA'          THEN 'CV'
        WHEN v_type = 'OPENING_BALANCE' THEN 'OB'
        WHEN v_type LIKE 'PMS%'         THEN 'PMS'
        ELSE 'JV'
    END;

    SELECT COALESCE(financial_year_start, 4) INTO v_fy_start_month
      FROM public.investors WHERE id = v_investor;
    IF v_fy_start_month IS NULL THEN v_fy_start_month := 4; END IF;

    v_fy_start_year := CASE WHEN EXTRACT(MONTH FROM v_date)::int >= v_fy_start_month
                            THEN EXTRACT(YEAR FROM v_date)::int
                            ELSE EXTRACT(YEAR FROM v_date)::int - 1 END;
    v_fy_start := make_date(v_fy_start_year, v_fy_start_month, 1);
    -- FY label e.g. 2024-04-01 -> '2425'
    v_fy_label := to_char(v_fy_start_year % 100, 'FM00') || to_char((v_fy_start_year + 1) % 100, 'FM00');

    -- next sequence within (book, family, FY)
    SELECT COUNT(*) + 1 INTO v_seq
      FROM public.acct_vouchers
     WHERE investor_id = v_investor
       AND voucher_number LIKE v_family || '-' || v_fy_label || '-%'
       AND voucher_date >= v_fy_start
       AND voucher_date < (v_fy_start + INTERVAL '1 year');

    v_number := v_family || '-' || v_fy_label || '-' || LPAD(v_seq::text, 4, '0');

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
