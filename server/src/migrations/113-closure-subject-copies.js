// Extend 112 without rewriting an applied migration. Actor and subject are
// separate identities: an active administrator may write about a closed login.
import pool from '../db.js'

export async function up() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_minimize_closed_login_copy()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE
      subject_id integer;
      actor_closed boolean;
      subject_closed boolean;
      copied_name text;
    BEGIN
      IF TG_TABLE_NAME = 'ochr_audit_log' THEN
        IF NEW.entity_type = 'user' AND NEW.entity_id ~ '^[0-9]+$' THEN
          SELECT id INTO subject_id FROM ochr_users
            WHERE organization_id = NEW.organization_id
              AND id::text = ltrim(NEW.entity_id, '0');
        END IF;
      END IF;
      IF TG_OP = 'INSERT' THEN
        -- Lock order is organization, then users (ascending). Organization
        -- HOLD and account operations take the organization first; taking a
        -- user row first here would deadlock against a HOLD that owns the
        -- organization and waits on that user (see organizationHoldLocks
        -- tests). KEY SHARE conflicts only with HOLD's FOR UPDATE.
        PERFORM 1 FROM ochr_organizations WHERE id = NEW.organization_id FOR KEY SHARE;
        -- A late INSERT then waits for closure before reading closed_at.
        PERFORM 1 FROM ochr_users
          WHERE organization_id = NEW.organization_id
            AND (id = NEW.user_id OR id = subject_id)
          ORDER BY id FOR SHARE;
      END IF;
      -- UPDATE already owns its audit row. Taking a user lock here would
      -- invert closure's user -> audit-row order and create a deadlock.
      SELECT closed_at IS NOT NULL INTO actor_closed FROM ochr_users
        WHERE organization_id = NEW.organization_id AND id = NEW.user_id;
      IF actor_closed IS TRUE THEN
        NEW.user_email := NULL;
        IF TG_TABLE_NAME = 'ochr_audit_log' THEN NEW.user_name := NULL; END IF;
      END IF;
      IF TG_TABLE_NAME = 'ochr_audit_log' AND subject_id IS NOT NULL THEN
        SELECT closed_at IS NOT NULL INTO subject_closed FROM ochr_users
          WHERE organization_id = NEW.organization_id AND id = subject_id;
        IF subject_closed IS TRUE THEN
          copied_name := NEW.metadata->>'name';
          IF copied_name IS NOT NULL AND NEW.summary IN (
            'Created user: ' || copied_name,
            'Updated user: ' || copied_name,
            'Deleted user: ' || copied_name
          ) THEN
            NEW.summary := regexp_replace(NEW.summary,
              '^(Created|Updated|Deleted) user: .*$', '\\1 user #' || subject_id::text);
          END IF;
          NEW.metadata := NEW.metadata - 'name' - 'email' - 'avatar';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `)
  // Existing closed subjects may predate this protection. Invoke the same
  // bounded trigger; do not guess names from unrelated text or rewrite actors.
  await pool.query(`
    UPDATE ochr_audit_log a SET metadata = a.metadata
      WHERE a.entity_type = 'user' AND a.entity_id ~ '^[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM ochr_users u
            WHERE u.organization_id = a.organization_id AND u.closed_at IS NOT NULL
              AND u.id::text = ltrim(a.entity_id, '0')
        )
  `)
  await pool.query(`
    UPDATE ochr_login_closure_reviews
      SET disposition = 'not_measured',
          note = 'Unmapped text is unmeasured; this stored zero is not a residue count.'
      WHERE kind = 'unmapped_text' AND disposition = 'speculative'
  `)
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_reject_closed_login_capability()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE is_closed boolean; tenant_id integer;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        -- Organization first, then the user row: the same order HOLD and
        -- account operations use. The tenant is read without a lock.
        IF TG_TABLE_NAME = 'ochr_push_subscriptions' THEN
          tenant_id := NEW.organization_id;
        ELSE
          SELECT organization_id INTO tenant_id FROM ochr_users WHERE id = NEW.user_id;
        END IF;
        PERFORM 1 FROM ochr_organizations WHERE id = tenant_id FOR KEY SHARE;
        PERFORM 1 FROM ochr_users WHERE id = NEW.user_id FOR SHARE;
      END IF;
      SELECT closed_at IS NOT NULL INTO is_closed FROM ochr_users WHERE id = NEW.user_id;
      IF is_closed IS TRUE THEN
        IF TG_TABLE_NAME = 'ochr_password_reset_tokens' THEN
          IF NEW.used_at IS NULL THEN
            RAISE EXCEPTION 'Closed login cannot receive a reset or invitation capability' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.removed_at IS NULL THEN
          RAISE EXCEPTION 'Closed login cannot receive a push capability' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS ochr_closed_login_capability_guard ON ochr_password_reset_tokens;
    CREATE TRIGGER ochr_closed_login_capability_guard BEFORE INSERT OR UPDATE ON ochr_password_reset_tokens
      FOR EACH ROW EXECUTE FUNCTION ochr_reject_closed_login_capability();
    DROP TRIGGER IF EXISTS ochr_closed_login_capability_guard ON ochr_push_subscriptions;
    CREATE TRIGGER ochr_closed_login_capability_guard BEFORE INSERT OR UPDATE ON ochr_push_subscriptions
      FOR EACH ROW EXECUTE FUNCTION ochr_reject_closed_login_capability();
  `)
  console.log('Migration 113: closure-subject-copies — applied.')
}
