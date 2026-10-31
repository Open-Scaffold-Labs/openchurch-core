// 128 — one person's agreement to AI inside the native iOS shell.
//
// ADDITIVE ONLY: one new table. No existing row is rewritten.
//
// A row is the fact that this login, in this parish, agreed to a named
// disclosure, and whether they later withdrew. It does not send anything.
// Withdrawal sets withdrawn_at. The row stays. One open row per login
// (withdrawn_at IS NULL). The user foreign key is composite onto
// ochr_users (id, organization_id).

import pool from '../db.js'

const T = 'ochr_native_ai_consents'

export async function up() {
  console.log('Migration 128: native-ai-consent — applying...')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${T} (
      id                  BIGSERIAL PRIMARY KEY,
      organization_id     INTEGER     NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id             INTEGER     NOT NULL,
      disclosure_version  TEXT        NOT NULL,
      consented_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      withdrawn_at        TIMESTAMPTZ,
      CONSTRAINT ochr_native_ai_consent_user_fk FOREIGN KEY (user_id, organization_id)
        REFERENCES ochr_users (id, organization_id) ON DELETE CASCADE
    )
  `)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ochr_native_ai_consent_one_open
    ON ${T} (organization_id, user_id) WHERE withdrawn_at IS NULL`)
  await pool.query(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`)
  const { rows: roles } = await pool.query(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
  for (const { rolname } of roles) {
    await pool.query(`REVOKE ALL ON ${T} FROM ${rolname}`)
  }
  await pool.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ${T}`)
  await pool.query(`CREATE TRIGGER ochr_organization_hold_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ${T}
    FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)

  const { rows: cols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = '${T}'
       AND column_name IN ('id', 'organization_id', 'user_id', 'disclosure_version', 'consented_at', 'withdrawn_at')
  `)
  if (cols.length !== 6) throw new Error('128: native AI consent columns did not land')

  const { rows: fk } = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'ochr_native_ai_consent_user_fk'
  `)
  if (!fk.length || !/organization_id/.test(fk[0].def) || !/ochr_users/.test(fk[0].def)) {
    throw new Error('128: consent FK is not a tenant composite onto ochr_users')
  }

  const { rows: uniq } = await pool.query(`
    SELECT pg_get_indexdef(i.oid) AS def FROM pg_class i
     WHERE i.relname = 'ochr_native_ai_consent_one_open'
  `)
  if (!uniq.length || !/UNIQUE/i.test(uniq[0].def) || !/organization_id/.test(uniq[0].def) || !/withdrawn_at/i.test(uniq[0].def)) {
    throw new Error('128: one-open consent index is missing')
  }

  const rls = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE relname = '${T}'`)
  if (rls.rows[0]?.relrowsecurity !== true) throw new Error('128: RLS is not enabled')

  console.log('Migration 128: native-ai-consent — done.')
}
