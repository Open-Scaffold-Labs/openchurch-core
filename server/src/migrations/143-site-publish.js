// 143 — Publish history for the parish site document (OC-WEB-1 PR-D).
//
// 142 stores the current draft and the current published snapshot. This
// table is the append-only book of publish, takedown, and restore. A later
// action inserts a new row; it does not rewrite or delete an earlier one.
// Revert walks previous_history_id. The live snapshot stays on
// ochr_site_documents.published_doc so anonymous reads do not join history.
//
// Tenancy: composite FKs, RLS on, REVOKE anon/authenticated, held-org guard.

import pool from '../db.js'

const T = 'ochr_site_publish_history'

export async function up() {
  console.log('Migration 143: site-publish — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${T} (
      id                   BIGSERIAL PRIMARY KEY,
      organization_id      INTEGER       NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      site_document_id     BIGINT        NOT NULL,
      seq                  INTEGER       NOT NULL,
      action               TEXT          NOT NULL,
      doc                  JSONB         NOT NULL,
      previous_history_id  BIGINT        NULL,
      actor_user_id        INTEGER       NULL,
      created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_site_publish_history_action_chk CHECK (
        action IN ('publish', 'unpublish', 'revert')
      ),
      CONSTRAINT ochr_site_publish_history_org_seq_uniq UNIQUE (organization_id, seq),
      CONSTRAINT ochr_site_publish_history_id_org_uniq UNIQUE (id, organization_id)
    )
  `)

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_site_publish_history_site_fk'
      ) THEN
        ALTER TABLE ${T}
          ADD CONSTRAINT ochr_site_publish_history_site_fk
          FOREIGN KEY (site_document_id, organization_id)
          REFERENCES ochr_site_documents (id, organization_id)
          ON DELETE CASCADE;
      END IF;
    END $$;
  `)

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_site_publish_history_actor_fk'
      ) THEN
        ALTER TABLE ${T}
          ADD CONSTRAINT ochr_site_publish_history_actor_fk
          FOREIGN KEY (actor_user_id, organization_id)
          REFERENCES ochr_users (id, organization_id)
          ON DELETE SET NULL (actor_user_id);
      END IF;
    END $$;
  `)

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_site_publish_history_prev_fk'
      ) THEN
        ALTER TABLE ${T}
          ADD CONSTRAINT ochr_site_publish_history_prev_fk
          FOREIGN KEY (previous_history_id, organization_id)
          REFERENCES ${T} (id, organization_id)
          ON DELETE SET NULL (previous_history_id);
      END IF;
    END $$;
  `)

  await pool.query(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`)

  const { rows: roles } = await pool.query(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`
  )
  for (const { rolname } of roles) {
    await pool.query(`REVOKE ALL ON ${T} FROM ${rolname}`)
  }

  await pool.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ${T}`)
  await pool.query(`
    CREATE TRIGGER ochr_organization_hold_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${T}
      FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()
  `)

  const { rows: rls } = await pool.query(
    `SELECT c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = '${T}' AND n.nspname = 'public'`
  )
  if (!rls[0]?.relrowsecurity) throw new Error('143: RLS is not enabled on ochr_site_publish_history')

  const { rows: cons } = await pool.query(
    `SELECT conname FROM pg_constraint
      WHERE conname IN (
        'ochr_site_publish_history_action_chk',
        'ochr_site_publish_history_org_seq_uniq',
        'ochr_site_publish_history_id_org_uniq',
        'ochr_site_publish_history_site_fk',
        'ochr_site_publish_history_actor_fk',
        'ochr_site_publish_history_prev_fk'
      )`
  )
  if (cons.length !== 6) {
    throw new Error(`143: expected 6 constraints, found ${cons.map((r) => r.conname).join(', ')}`)
  }

  console.log('Migration 143: site-publish — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
