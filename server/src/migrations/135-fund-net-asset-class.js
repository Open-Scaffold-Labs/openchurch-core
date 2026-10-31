// 135 — fund net-asset class, append-only restriction releases, ASC 958 labels.
//
// BOOKS-1.1 (José, 2026-10-27, 1:37 PM PT): two ASC 958 classes
// (with/without donor restriction); ship before reclass/S3 so a class flip
// after gifts is refused until S3 exists. Migration 134 stays reserved.
// D2: pass-through mappings (4450/2320) are written by a chancery route
// with set_by='diocese' — not a parish allow. This migration only adds the
// fund columns, the release facts table, and display renames for 3110/3120.
// Mapping write rules and the chancery route live in app code.
//
// ADDITIVE. One REPEATABLE READ transaction. Default class keeps today's
// meaning (without_donor_restriction). No donation / ledger rewrite.

import pool from '../db.js'

const RELEASES = 'ochr_fund_restriction_releases'

async function addConstraintIfMissing(db, name, ddl) {
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
      ${ddl};
    END IF;
  END $$;`)
}

export async function up() {
  console.log('Migration 135: fund-net-asset-class — applying...')
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await client.query(`SET LOCAL lock_timeout = '5s'`)

    await addConstraintIfMissing(client, 'ochr_funds_id_org_uniq',
      `ALTER TABLE ochr_funds ADD CONSTRAINT ochr_funds_id_org_uniq UNIQUE (id, organization_id)`)

    await client.query(`
      ALTER TABLE ochr_funds
        ADD COLUMN IF NOT EXISTS net_asset_class TEXT NOT NULL DEFAULT 'without_donor_restriction',
        ADD COLUMN IF NOT EXISTS restriction_nature TEXT,
        ADD COLUMN IF NOT EXISTS restriction_purpose TEXT,
        ADD COLUMN IF NOT EXISTS class_set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS class_set_by INTEGER
    `)

    await client.query(`ALTER TABLE ochr_funds DROP CONSTRAINT IF EXISTS ochr_funds_net_asset_class_check`)
    await client.query(`
      ALTER TABLE ochr_funds
        ADD CONSTRAINT ochr_funds_net_asset_class_check
        CHECK (net_asset_class IN ('without_donor_restriction', 'with_donor_restriction'))
    `)
    await client.query(`ALTER TABLE ochr_funds DROP CONSTRAINT IF EXISTS ochr_funds_restriction_nature_check`)
    await client.query(`
      ALTER TABLE ochr_funds
        ADD CONSTRAINT ochr_funds_restriction_nature_check
        CHECK (
          (net_asset_class = 'without_donor_restriction'
             AND restriction_nature IS NULL
             AND restriction_purpose IS NULL)
          OR
          (net_asset_class = 'with_donor_restriction'
             AND restriction_nature IN ('purpose', 'time', 'perpetual')
             AND (restriction_nature <> 'purpose'
                  OR (restriction_purpose IS NOT NULL AND length(btrim(restriction_purpose)) > 0)))
        )
    `)
    await addConstraintIfMissing(client, 'ochr_funds_class_set_by_fk',
      `ALTER TABLE ochr_funds ADD CONSTRAINT ochr_funds_class_set_by_fk
         FOREIGN KEY (class_set_by, organization_id)
         REFERENCES ochr_users (id, organization_id) ON DELETE RESTRICT`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${RELEASES} (
        id                  BIGSERIAL PRIMARY KEY,
        organization_id     INTEGER       NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
        fund_id             BIGINT        NOT NULL,
        kind                TEXT          NOT NULL,
        amount              NUMERIC(12,2) NOT NULL,
        released_on         DATE          NOT NULL,
        qualifying_memo     TEXT,
        requester_user_id   INTEGER       NOT NULL,
        approver_user_id    INTEGER,
        approval_mode       TEXT          NOT NULL DEFAULT 'second_admin',
        reason              TEXT,
        reverses_release_id BIGINT,
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT ochr_fund_releases_kind_check
          CHECK (kind IN ('release', 'reverse')),
        CONSTRAINT ochr_fund_releases_amount_check CHECK (amount > 0),
        CONSTRAINT ochr_fund_releases_reverse_link
          CHECK ((kind = 'reverse') = (reverses_release_id IS NOT NULL)),
        CONSTRAINT ochr_fund_releases_approval_mode
          CHECK (approval_mode IN ('second_admin', 'single_admin')),
        CONSTRAINT ochr_fund_releases_second_person
          CHECK (approval_mode <> 'second_admin'
                 OR (approver_user_id IS NOT NULL
                     AND approver_user_id IS DISTINCT FROM requester_user_id)),
        CONSTRAINT ochr_fund_releases_single_reason
          CHECK (approval_mode <> 'single_admin'
                 OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),
        CONSTRAINT ochr_fund_releases_fund_fk FOREIGN KEY (fund_id, organization_id)
          REFERENCES ochr_funds (id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT ochr_fund_releases_requester_fk FOREIGN KEY (requester_user_id, organization_id)
          REFERENCES ochr_users (id, organization_id) ON DELETE RESTRICT,
        CONSTRAINT ochr_fund_releases_approver_fk FOREIGN KEY (approver_user_id, organization_id)
          REFERENCES ochr_users (id, organization_id) ON DELETE RESTRICT
      )
    `)
    await addConstraintIfMissing(client, 'ochr_fund_releases_id_org_uniq',
      `ALTER TABLE ${RELEASES} ADD CONSTRAINT ochr_fund_releases_id_org_uniq UNIQUE (id, organization_id)`)
    await addConstraintIfMissing(client, 'ochr_fund_releases_reverses_fk',
      `ALTER TABLE ${RELEASES} ADD CONSTRAINT ochr_fund_releases_reverses_fk
         FOREIGN KEY (reverses_release_id, organization_id)
         REFERENCES ${RELEASES} (id, organization_id) ON DELETE RESTRICT`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_fund_releases_one_reverse
      ON ${RELEASES} (reverses_release_id) WHERE reverses_release_id IS NOT NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fund_releases_fund
      ON ${RELEASES} (organization_id, fund_id, released_on)`)
    await client.query(`ALTER TABLE ${RELEASES} ENABLE ROW LEVEL SECURITY`)

    await client.query(`
      CREATE OR REPLACE FUNCTION ochr_fund_releases_append_only()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'fund restriction releases are append-only; post a reverse instead'
            USING ERRCODE = '55000';
        END IF;
        IF TG_OP = 'DELETE' THEN
          IF pg_trigger_depth() <= 1 THEN
            RAISE EXCEPTION 'fund restriction releases are append-only; post a reverse instead'
              USING ERRCODE = '55000';
          END IF;
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await client.query(`DROP TRIGGER IF EXISTS ochr_fund_releases_append_only ON ${RELEASES}`)
    await client.query(`CREATE TRIGGER ochr_fund_releases_append_only
      BEFORE UPDATE OR DELETE ON ${RELEASES}
      FOR EACH ROW EXECUTE FUNCTION ochr_fund_releases_append_only()`)

    const { rows: roles } = await client.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
    for (const { rolname } of roles) {
      await client.query(`REVOKE ALL ON ${RELEASES} FROM ${rolname}`)
    }
    await client.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ${RELEASES}`)
    await client.query(`CREATE TRIGGER ochr_organization_hold_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${RELEASES}
      FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)

    // Display rename only — codes stay. ASC 958 ASU 2016-14 wording.
    await client.query(`
      UPDATE ochr_coa_accounts
         SET name = 'Net Assets — Without Donor Restrictions'
       WHERE organization_id IS NULL AND code = '3110'
         AND name IS DISTINCT FROM 'Net Assets — Without Donor Restrictions'
    `)
    await client.query(`
      UPDATE ochr_coa_accounts
         SET name = 'Net Assets — With Donor Restrictions'
       WHERE organization_id IS NULL AND code = '3120'
         AND name IS DISTINCT FROM 'Net Assets — With Donor Restrictions'
    `)

    // Fail closed: composite unique and RLS must be present.
    const { rows: uniq } = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'ochr_funds_id_org_uniq'`)
    if (!uniq.length) throw new Error('135: ochr_funds missing UNIQUE (id, organization_id)')
    const { rows: rls } = await client.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'ochr_fund_restriction_releases'`)
    if (!rls.length || !rls[0].relrowsecurity) {
      throw new Error('135: release table RLS not enabled')
    }
    const { rows: cols } = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ochr_funds' AND column_name = 'net_asset_class'`)
    if (!cols.length) throw new Error('135: net_asset_class column missing')

    await client.query('COMMIT')
    console.log('Migration 135: fund-net-asset-class — applied.')
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already closed */ }
    throw err
  } finally {
    client.release()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
