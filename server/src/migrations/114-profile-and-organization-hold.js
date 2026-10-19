import pool from '../db.js'

export async function up() {
  await pool.query(`
    ALTER TABLE ochr_clients ADD COLUMN IF NOT EXISTS deidentified_at TIMESTAMPTZ;
    ALTER TABLE ochr_organizations ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS held_by INTEGER;
    CREATE TABLE IF NOT EXISTS ochr_profile_minimizations (
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      client_id INTEGER NOT NULL,
      deidentified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, client_id)
    );
    -- client_id deliberately has no client FK: a vaulted directory removal
    -- must not erase the marker and let an older snapshot restore contact data.
    CREATE OR REPLACE FUNCTION ochr_preserve_profile_minimization()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE minimized_at TIMESTAMPTZ;
    BEGIN
      SELECT deidentified_at INTO minimized_at FROM ochr_profile_minimizations
        WHERE organization_id = NEW.organization_id AND client_id = NEW.id;
      IF minimized_at IS NOT NULL THEN
        IF NEW.email IS NOT NULL OR NEW.phone IS NOT NULL OR NEW.notes IS NOT NULL
           OR NEW.avatar IS NOT NULL OR NEW.birth_date IS NOT NULL
           OR NEW.calendar_token IS NOT NULL OR NEW.swap_token IS NOT NULL
           OR NEW.status IS DISTINCT FROM 'inactive' THEN
          RAISE EXCEPTION 'Profile contact data has been minimized' USING ERRCODE = '23514';
        END IF;
        NEW.deidentified_at := minimized_at;
      END IF;
      RETURN NEW;
    END $fn$;
    -- Audit copies of a minimized member's contact details: the request body
    -- that created or edited the member is stored in audit metadata. Rows
    -- ABOUT the member (entity client, canonical or zero-padded id) lose the
    -- contact keys at minimization (routes/clients.js); this keeps a late or
    -- rewritten row from carrying them back. Names stay: member names are
    -- retained.
    --
    -- Concurrency. Minimization scrubs only the audit rows its statement can
    -- see, so a row written by a transaction still open at that moment would
    -- escape it (reproduced: tests/stage6AuditCopyRace.test.js). Minimization
    -- holds an exclusive transaction advisory lock on (organization, member)
    -- for its whole transaction (ochr_member_minimization_key). A write that
    -- would put contact keys on a row about that member TRIES the shared lock:
    --   * acquired: held to the end of the writer's transaction, so a later
    --     minimization waits for this row to commit and then scrubs it;
    --   * not acquired: a minimization is in flight; the keys are dropped now.
    -- The writer never waits, so it cannot join a cycle with minimization
    -- (which may be waiting on this very audit row's lock).
    CREATE OR REPLACE FUNCTION ochr_member_minimization_key(org_id INTEGER, member_id BIGINT)
    RETURNS BIGINT LANGUAGE sql IMMUTABLE AS $fn$
      SELECT hashtextextended('ochr:member-minimization:' || org_id || ':' || member_id, 0)
    $fn$;
    CREATE OR REPLACE FUNCTION ochr_minimize_deidentified_client_copy()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE member_id BIGINT;
    BEGIN
      IF NEW.entity_type = 'client' AND NEW.entity_id ~ '^0*[1-9][0-9]{0,17}$'
         AND NEW.metadata ?| ARRAY['email', 'phone', 'notes', 'avatar', 'birth_date'] THEN
        member_id := ltrim(NEW.entity_id, '0')::bigint;
        IF NOT pg_try_advisory_xact_lock_shared(ochr_member_minimization_key(NEW.organization_id, member_id))
           OR EXISTS (SELECT 1 FROM ochr_profile_minimizations m
                       WHERE m.organization_id = NEW.organization_id AND m.client_id = member_id) THEN
          NEW.metadata := NEW.metadata - 'email' - 'phone' - 'notes' - 'avatar' - 'birth_date';
        END IF;
      END IF;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS ochr_audit_minimize_deidentified_client ON ochr_audit_log;
    CREATE TRIGGER ochr_audit_minimize_deidentified_client BEFORE INSERT OR UPDATE ON ochr_audit_log
      FOR EACH ROW EXECUTE FUNCTION ochr_minimize_deidentified_client_copy();
    DROP TRIGGER IF EXISTS ochr_profile_minimization_guard ON ochr_clients;
    CREATE TRIGGER ochr_profile_minimization_guard BEFORE INSERT OR UPDATE ON ochr_clients
      FOR EACH ROW EXECUTE FUNCTION ochr_preserve_profile_minimization();
    CREATE OR REPLACE FUNCTION ochr_held_organization_write_guard()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE tenant_id INTEGER; hold_time TIMESTAMPTZ;
    BEGIN
      tenant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
      -- HOLD's revocation phase runs after the hold is committed and marks
      -- its own transaction (SET LOCAL). Nothing else sets this.
      IF current_setting('ochr.hold_revocation_org', true) = tenant_id::text THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;
      -- The existing check-in redaction policy keeps running for a held
      -- organization (services/retention.js redactCheckins). Its transaction
      -- marks itself for exactly this organization, holds the admission lock,
      -- and may only redact: an UPDATE of ochr_checkins that changes no
      -- column except person_name (to 'Redacted', the retention constant),
      -- guardian_name (to NULL) and security_code_hash (to NULL).
      IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'ochr_checkins'
         AND current_setting('ochr.checkin_redaction_org', true) = tenant_id::text
         AND (to_jsonb(NEW) - 'person_name' - 'guardian_name' - 'security_code_hash')
             = (to_jsonb(OLD) - 'person_name' - 'guardian_name' - 'security_code_hash')
         AND (to_jsonb(NEW)->>'person_name' = to_jsonb(OLD)->>'person_name' OR to_jsonb(NEW)->>'person_name' = 'Redacted')
         AND (to_jsonb(NEW)->>'guardian_name' IS NOT DISTINCT FROM to_jsonb(OLD)->>'guardian_name' OR to_jsonb(NEW)->>'guardian_name' IS NULL)
         AND (to_jsonb(NEW)->>'security_code_hash' IS NOT DISTINCT FROM to_jsonb(OLD)->>'security_code_hash' OR to_jsonb(NEW)->>'security_code_hash' IS NULL) THEN
        RETURN NEW;
      END IF;
      -- Every write takes the admission lock. KEY SHARE conflicts only with
      -- HOLD's FOR UPDATE, so ordinary writers never block each other or
      -- organization settings edits. An UPDATE/DELETE already owns its row
      -- lock here. That is safe only while two rules hold: HOLD's locking
      -- phase holds nothing but the organization row (organizationHold.js),
      -- and no other path takes FOR UPDATE on the organization row
      -- (numbering serializers use FOR NO KEY UPDATE, which does not conflict
      -- with KEY SHARE). tests/organizationHoldJobs.test.js enforces the
      -- second rule. The result is a strict boundary: HOLD commits only after
      -- in-flight writes for this organization finish, and every later write
      -- sees held_at.
      SELECT held_at INTO hold_time FROM ochr_organizations WHERE id = tenant_id FOR KEY SHARE;
      IF hold_time IS NOT NULL THEN
        RAISE EXCEPTION 'Organization is on hold' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $fn$;
    DO $do$
    DECLARE tab RECORD;
    BEGIN
      FOR tab IN SELECT c.table_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'organization_id'
          AND t.table_type = 'BASE TABLE'
          AND c.table_name LIKE 'ochr_%'
          AND c.table_name NOT IN ('ochr_audit_log', 'ochr_login_closures', 'ochr_billing_event_receipts')
      LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON %I', tab.table_name);
        EXECUTE format('CREATE TRIGGER ochr_organization_hold_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()', tab.table_name);
      END LOOP;
    END $do$;
    CREATE OR REPLACE FUNCTION ochr_held_org_reset_guard()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE hold_time TIMESTAMPTZ;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        SELECT o.held_at INTO hold_time FROM ochr_organizations o JOIN ochr_users u ON u.organization_id = o.id
          WHERE u.id = NEW.user_id FOR KEY SHARE OF o;
      ELSE
        SELECT o.held_at INTO hold_time FROM ochr_organizations o JOIN ochr_users u ON u.organization_id = o.id
          WHERE u.id = NEW.user_id FOR KEY SHARE OF o;
      END IF;
      IF hold_time IS NOT NULL THEN
        RAISE EXCEPTION 'Organization is on hold' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ochr_password_reset_tokens;
    CREATE TRIGGER ochr_organization_hold_guard BEFORE INSERT OR UPDATE ON ochr_password_reset_tokens
      FOR EACH ROW EXECUTE FUNCTION ochr_held_org_reset_guard();
    CREATE OR REPLACE FUNCTION ochr_preserve_organization_hold()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.held_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Organization hold cannot be cleared or edited here' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS ochr_preserve_organization_hold ON ochr_organizations;
    CREATE TRIGGER ochr_preserve_organization_hold BEFORE UPDATE ON ochr_organizations
      FOR EACH ROW EXECUTE FUNCTION ochr_preserve_organization_hold();
  `)
}
