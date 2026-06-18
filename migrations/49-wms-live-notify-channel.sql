-- Migration 49 — Phase F1: Postgres LISTEN/NOTIFY for wms-live command intake.
--
-- Replaces the 1.5-second Edge Function polling loop with a push-based
-- notification model. Architecture:
--
--   1. Any source INSERTs into wms_live_commands with status='pending'.
--   2. The trg_wms_live_commands_notify TRIGGER fires AFTER INSERT.
--   3. The trigger calls pg_notify('wms_live_commands_new', NEW.id::text).
--   4. The wms-live service on the Droplet, connected as wms_live_notify_only
--      role with a persistent LISTEN, receives the notification and calls
--      wms-live-cmd-poll via HMAC to atomically claim the row + get broker
--      creds.
--
-- The wms_live_notify_only role has NO data privileges. It can only LISTEN
-- and gets row IDs (not row contents). Actual data access still requires
-- service_role inside the Edge Function. Compromise of this role grants
-- zero data access — just "tap me on the shoulder" rights.
--
-- A 60-second safety-net Edge Function poll on the Droplet covers gap
-- recovery: if the Postgres connection drops or a NOTIFY is missed during
-- reconnect, the next safety-net poll catches up.
--
-- Free plan quota impact: command intake goes from ~1.73M Edge Function
-- invocations/month (1.5s poll) to ~22K (60s safety-net) + 1 per actual
-- command. Total ~24-30K/month for expected volume. Well under 500K cap.

-- ============================================================================
-- 1. Restricted role for the Droplet's LISTEN client
-- ============================================================================
--
-- Role intentionally has NO permissions on any table. PostgreSQL's
-- LISTEN/NOTIFY does not require any GRANT on the channel — any role with
-- CONNECT to the database can LISTEN on any channel name. So we grant
-- ONLY: LOGIN + CONNECT + USAGE on schema public.
--
-- The role's password is set OUTSIDE this migration (run separately in
-- Studio SQL Editor) so the password value is never committed to git:
--
--   ALTER USER wms_live_notify_only PASSWORD '<32-byte-random-from-Vikash>';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_live_notify_only') THEN
    CREATE ROLE wms_live_notify_only WITH LOGIN PASSWORD NULL;
    RAISE NOTICE 'Created role wms_live_notify_only (NO PASSWORD — set via ALTER USER).';
  ELSE
    RAISE NOTICE 'Role wms_live_notify_only already exists; skipping CREATE.';
  END IF;
END $$;

-- Minimum privileges to connect + listen
GRANT CONNECT ON DATABASE postgres TO wms_live_notify_only;
GRANT USAGE   ON SCHEMA public     TO wms_live_notify_only;

-- Explicitly REVOKE everything else as belt-and-suspenders.
-- These are no-ops if no grants existed, but make the intent clear in the
-- migration history.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM wms_live_notify_only;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM wms_live_notify_only;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM wms_live_notify_only;

-- Make this stick for future tables / objects created in public.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES    FROM wms_live_notify_only;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM wms_live_notify_only;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM wms_live_notify_only;

COMMENT ON ROLE wms_live_notify_only IS
  'Phase 13 notify-only Postgres role for the wms-live Droplet client. '
  'Has CONNECT to database + USAGE on schema public — nothing else. '
  'Used solely to LISTEN on wms_live_commands_new. Compromise of this role '
  'grants ZERO data access (no SELECT/INSERT/UPDATE/DELETE on any table).';

-- ============================================================================
-- 2. Trigger function + trigger on wms_live_commands
-- ============================================================================
--
-- Fires on INSERT only. Filters: only NOTIFY when status='pending' (the
-- normal initial state). Skip if a future code path inserts already-claimed
-- or cancelled rows for backfill (won't happen today, but defensive).
--
-- Payload is just the row's id (UUID as text). Keeps the NOTIFY payload
-- small (PostgreSQL limits NOTIFY payload to 8000 bytes by default; a UUID
-- is 36 chars, plenty of headroom). The Droplet uses cmd-poll to fetch the
-- full row contents + broker creds — so we don't need to pack everything
-- into the notification.

CREATE OR REPLACE FUNCTION public.notify_wms_live_commands_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER  -- pg_notify works without this, but explicit is safer
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM pg_notify('wms_live_commands_new', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_wms_live_commands_insert() IS
  'AFTER INSERT trigger function. Calls pg_notify(''wms_live_commands_new'', NEW.id) '
  'when status=''pending''. Wakes up the wms-live LISTEN client on the Droplet so '
  'it can immediately call wms-live-cmd-poll to claim + place the order.';

DROP TRIGGER IF EXISTS trg_wms_live_commands_notify ON public.wms_live_commands;
CREATE TRIGGER trg_wms_live_commands_notify
  AFTER INSERT ON public.wms_live_commands
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_wms_live_commands_insert();

-- ============================================================================
-- 3. Verification queries (run manually after applying)
-- ============================================================================
--
-- Role exists with the right shape:
--   SELECT rolname, rolcanlogin, rolconnlimit
--   FROM pg_roles WHERE rolname = 'wms_live_notify_only';
--
-- Role has NO table privileges (should return 0 rows):
--   SELECT grantee, table_schema, table_name, privilege_type
--   FROM information_schema.table_privileges
--   WHERE grantee = 'wms_live_notify_only';
--
-- Trigger is wired:
--   SELECT tgname, tgenabled, pg_get_triggerdef(oid)
--   FROM pg_trigger WHERE tgname = 'trg_wms_live_commands_notify';
--
-- Live test (run in TWO separate Studio SQL Editor tabs — Postgres LISTEN
-- doesn't work via PostgREST; you can ALSO test from a psql client):
--   -- Tab 1:
--   LISTEN wms_live_commands_new;
--   -- (Studio's SQL Editor may not surface NOTIFY responses; this test is
--   -- more useful from the Droplet's pg client once it's wired up.)
--
--   -- Tab 2:
--   INSERT INTO wms_live_commands (signal_source, iba_id, payload)
--   VALUES ('test', '9e61d507-ee9d-48fb-9fcf-3b539f3c5c8d'::uuid, '{}'::jsonb);
--   -- (Tab 1's LISTEN should receive a notification with payload = the new id.)
--   -- Then clean up:
--   DELETE FROM wms_live_commands WHERE signal_source = 'test';

-- ============================================================================
-- 4. Owner action items (Vikash, after running this migration)
-- ============================================================================
--
-- A. Set the role's password (generate fresh):
--      openssl rand -hex 24   # on Mac, save to password manager
--    Then in Studio SQL Editor:
--      ALTER USER wms_live_notify_only PASSWORD '<paste-the-hex>';
--
-- B. Get Supabase Postgres connection details:
--      Supabase Studio → Project Settings → Database → Connection String
--      Use the "Session pooler" connection (port 5432, supports LISTEN/NOTIFY)
--      NOT the "Transaction pooler" (port 6543, breaks LISTEN/NOTIFY)
--    Note: host, port, database name.
--
-- C. Update Droplet .env (see wms-live/.env.example for the new keys):
--      PG_HOST=...
--      PG_PORT=5432
--      PG_DATABASE=postgres
--      PG_USER=wms_live_notify_only
--      PG_PASSWORD=<the-hex-from-A>
--
-- D. Re-enable + start the service after the new code is deployed:
--      sudo systemctl enable wms-live
--      sudo systemctl start wms-live
