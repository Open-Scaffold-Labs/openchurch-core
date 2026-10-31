// 141 — DB CHECKs for public branding columns (OC-WEB-1 PR-B / Argus N451-1).
//
// PR-A (140) added the nullable branding columns. This follow-up adds
// defense-in-depth CHECKs so a raw SQL write cannot store a non-https logo
// or a non-#RRGGBB accent. Admin PATCH still validates with the same
// helpers used by resolvePublicBranding.
//
// Logo CHECK mirrors isSafeHttpsLogoUrl: https only, no userinfo in the
// authority (reject '^https://[^/]*@'), and length ≤ 500. Accent matches
// #RRGGBB. Constraint is dropped+re-added so local DBs that applied the
// earlier weak '^https://' CHECK pick up the tight rule (141 unshipped;
// prod still at 140).
//
// ADD COLUMN IF NOT EXISTS is repeated here deliberately: the rollback
// classifier only treats a CHECK as safe when every column it names is
// also added in the same migration file (old code cannot write columns
// it has never heard of). On a DB that already ran 140 the ADD is a
// no-op; on a fresh chain 140 and 141 both no-op after the first ADD.
//
// Idempotent: columns and constraints are added only when missing
// (logo CHECK is recreated to the current definition).

import pool from '../db.js'

export async function up() {
  console.log('Migration 141: public-branding-checks — applying...')

  // Visible to rollback-classify.mjs (ADD COLUMN … IF NOT EXISTS).
  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS public_display_name TEXT,
      ADD COLUMN IF NOT EXISTS public_logo_url     TEXT,
      ADD COLUMN IF NOT EXISTS public_accent_hex   TEXT
  `)

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ochr_organizations_public_accent_hex_chk'
      ) THEN
        ALTER TABLE ochr_organizations
          ADD CONSTRAINT ochr_organizations_public_accent_hex_chk
          CHECK (
            public_accent_hex IS NULL
            OR public_accent_hex ~ '^#[0-9A-Fa-f]{6}$'
          );
      END IF;

      -- Recreate logo CHECK so an earlier weak '^https://' definition
      -- (still unshipped to prod) is replaced by the JS-aligned rule.
      ALTER TABLE ochr_organizations
        DROP CONSTRAINT IF EXISTS ochr_organizations_public_logo_url_chk;
      ALTER TABLE ochr_organizations
        ADD CONSTRAINT ochr_organizations_public_logo_url_chk
        CHECK (
          public_logo_url IS NULL
          OR (
            char_length(public_logo_url) <= 500
            AND public_logo_url ~ '^https://'
            AND public_logo_url !~ '^https://[^/]*@'
          )
        );
    END
    $$;
  `)

  console.log('Migration 141: public-branding-checks — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
