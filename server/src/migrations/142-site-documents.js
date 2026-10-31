// 142 — Per-org public site document (OC-WEB-1 PR-C).
//
// Atlas libraries-only plan + Dale #342 answers (2026-10-29):
// OpenChurch owns persistence. Dale @openscaffold/website is consumed as
// vendored libraries (blocks / connectors / looks / SEO), never via
// createWebsiteSchema or Dale's admin/public routers.
//
// One row per organization:
//   draft_doc      — admin-edited JSON (pages + allowlisted blocks)
//   published_doc  — snapshot for anonymous /p/:slug (null = legacy 4-box)
//   look_id        — parish-admin look choice (visitor HC toggle is client-only)
//   custom_domain  — reserved NULL for PR-K; unused in C–J
//
// Publish / preview / nav hardening lands in PR-D. This migration only
// stubs the snapshot columns so D is not a rewrite.
//
// Tenancy: composite (id, organization_id), RLS on, REVOKE anon/authenticated,
// held-org write guard. 141 is branding CHECKs; this is 142.

import pool from '../db.js'

const T = 'ochr_site_documents'

export async function up() {
  console.log('Migration 142: site-documents — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${T} (
      id                   BIGSERIAL PRIMARY KEY,
      organization_id      INTEGER       NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      draft_doc            JSONB         NOT NULL DEFAULT '{"version":1,"pages":[],"nav":[]}'::jsonb,
      published_doc        JSONB         NULL,
      published_at         TIMESTAMPTZ   NULL,
      published_by_user_id INTEGER       NULL,
      look_id              TEXT          NOT NULL DEFAULT 'warm-editorial',
      revision             INTEGER       NOT NULL DEFAULT 0,
      custom_domain        TEXT          NULL,
      created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_site_documents_org_uniq UNIQUE (organization_id),
      CONSTRAINT ochr_site_documents_look_id_chk CHECK (
        look_id IN ('warm-editorial', 'clinical-light', 'midnight', 'high-contrast')
      ),
      CONSTRAINT ochr_site_documents_custom_domain_unused_chk CHECK (
        custom_domain IS NULL
      ),
      CONSTRAINT ochr_site_documents_published_pair_chk CHECK (
        (published_doc IS NULL AND published_at IS NULL AND published_by_user_id IS NULL)
        OR
        (published_doc IS NOT NULL AND published_at IS NOT NULL)
      )
    )
  `)

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_site_documents_id_org_uniq'
      ) THEN
        ALTER TABLE ${T}
          ADD CONSTRAINT ochr_site_documents_id_org_uniq UNIQUE (id, organization_id);
      END IF;
    END $$;
  `)

  // Composite FK to the publishing actor (nullable until PR-D publish path).
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_site_documents_published_by_fk'
      ) THEN
        ALTER TABLE ${T}
          ADD CONSTRAINT ochr_site_documents_published_by_fk
          FOREIGN KEY (published_by_user_id, organization_id)
          REFERENCES ochr_users (id, organization_id)
          ON DELETE SET NULL (published_by_user_id);
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

  console.log('Migration 142: site-documents — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
