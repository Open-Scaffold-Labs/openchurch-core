// 132 — effective-dated chart mappings and the books cutover.
//
// OC-BOOKS-1 S0, S1, and S1b. Catering owns 133 and another branch owns
// 134; this file is 132 on purpose. Correcting entries are a later slice.
//
// Mappings gain effective_from and superseded_on. Existing rows start at
// -infinity and stay open, so a gift resolves exactly as it did before this
// migration until a new row is appended. The parish ledger view picks the
// row in effect on entry_date by the exact source key. It does not rewrite
// ochr_donations or ochr_ledger_entries. Keys that differ only by case
// ('Offering' and 'offering') were separate rows under the old exact
// UNIQUE, and they stay separate: the open-row index is exact too.
//
// The cutover date is chosen once, here, inside the migration's one
// transaction, as the later of 2026-10-27 and the day after the latest
// calendar day any parish (or the database clock) is on. No parish is
// past it when it is stored, so nothing already entered for "today"
// changes account. From that day forward, an unmapped donation has no
// account. It is not coerced to 4420. Category defaults
// (offering/offertory/tithe → 4110, special collection → 2320, special
// offering → 4420) are template rows on each parish, effective that day.
//
// 4420 remains the resolution only when entry_date is before the cutover
// and nothing was mapped. Parity: every org/month/account total dated
// before the cutover must be identical under the new view, or the whole
// migration rolls back. Gifts already entered with a date on or after the
// cutover (future-dated, typo'd years) are meant to follow the new rules;
// they move and are counted, unless one sits in a period already submitted
// to or approved by the diocese, which aborts.
//
// Everything below runs in ONE transaction (REPEATABLE READ, gifts and
// payroll share-locked), so an abort leaves no half-applied schema and no
// stored cutover, and a gift committed mid-run cannot skew the check.

import pool from '../db.js'
import { LEDGER_DEPOSIT_BRANCH } from './130-event-deposits.js'
import { TEMPLATE_CATEGORY_DEFAULTS } from '../finance/booksMappings.js'
import { ledgerTotalsDiffer } from '../finance/mappingParity.js'

const DEFAULT_VALUES = TEMPLATE_CATEGORY_DEFAULTS
  .map(([key, code]) => `('${key}', '${code}')`)
  .join(', ')

const DONATION_ACCOUNT = `COALESCE(
      CASE WHEN d.fund_id IS NOT NULL
           THEN ochr_mapping_account(d.organization_id, 'fund', d.fund_id::text, d.date::date)
      END,
      ochr_mapping_account(
        d.organization_id, 'donation_category',
        COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized'), d.date::date),
      CASE WHEN d.date::date < (SELECT cutover_on FROM ochr_books_cutover) THEN '4420' ELSE NULL END
    )`

const LEDGER_VIEW = `
    CREATE OR REPLACE VIEW ochr_parish_ledger WITH (security_invoker = true) AS
    SELECT
      le.organization_id, le.entry_date, le.account_code, le.amount,
      le.source_type, le.id AS source_id, le.memo
    FROM ochr_ledger_entries le

    UNION ALL

    SELECT
      d.organization_id,
      d.date::date AS entry_date,
      ${DONATION_ACCOUNT} AS account_code,
      d.amount AS amount,
      'donation' AS source_type,
      d.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d

    UNION ALL

    SELECT
      r.organization_id,
      d.date::date AS entry_date,
      ${DONATION_ACCOUNT} AS account_code,
      (-r.amount)::NUMERIC(12,2) AS amount,
      'donation_refund' AS source_type,
      r.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donation_refunds r
    JOIN ochr_donations d
      ON d.id = r.donation_id AND d.organization_id = r.organization_id
    WHERE r.status = 'posted'

    UNION ALL

    SELECT
      d.organization_id,
      d.date::date AS entry_date,
      ${DONATION_ACCOUNT} AS account_code,
      (-d.amount)::NUMERIC(12,2) AS amount,
      'donation_refund' AS source_type,
      d.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d
    WHERE d.payment_status = 'refunded'
      AND NOT EXISTS (
        SELECT 1 FROM ochr_donation_refunds r
         WHERE r.donation_id = d.id
           AND r.organization_id = d.organization_id
           AND r.status = 'posted'
      )

    UNION ALL

    SELECT
      s.organization_id,
      sh.date::date AS entry_date,
      COALESCE(ochr_mapping_account(s.organization_id, 'payroll', 'wages', sh.date::date), '5120') AS account_code,
      (sh.hours * s.pay_rate)::NUMERIC(12,2) AS amount,
      'payroll' AS source_type,
      sh.id AS source_id,
      s.name AS memo
    FROM ochr_payroll_shifts sh
    JOIN ochr_payroll_staff s ON s.id = sh.staff_id
    ${LEDGER_DEPOSIT_BRANCH}
  `

const LATE_SOURCES = `('donation', 'donation_refund', 'payroll')`

// The floor: the later of 2026-10-27 and the day after the latest calendar
// day any parish (or the database clock) is on.
const CUTOVER_FLOOR = `
    GREATEST(
      DATE '2026-10-27',
      GREATEST(
        CURRENT_DATE,
        (now() AT TIME ZONE 'UTC')::date,
        COALESCE((
          SELECT MAX((now() AT TIME ZONE z.name)::date)
            FROM ochr_organizations o
            JOIN pg_timezone_names z ON z.name = o.timezone
        ), CURRENT_DATE)
      ) + 1)
  `

// Ledger R1: an earlier head of 132 stored the cutover in its own commit and
// could then fail, leaving a row with a date that is now some parish's today
// or earlier. 132 is not recorded in that state, so the row is chosen again
// here, inside this transaction. Only a database where this migration
// already finished (its last step, the org seeding trigger, exists) keeps the
// stored date, so a direct second run does not move it.
const CUTOVER_SQL = `
    INSERT INTO ochr_books_cutover (id, cutover_on)
    SELECT TRUE, ${CUTOVER_FLOOR}
    ON CONFLICT (id) DO UPDATE
      SET cutover_on = EXCLUDED.cutover_on
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'ochr_seed_category_defaults'
           AND tgrelid = 'ochr_organizations'::regclass
           AND NOT tgisinternal)
  `

// Carolina R3 race: a gift, refund, or shift written while a mapping save is
// in flight was read on the old account and then restated by the save. Every
// write to those tables (any route, import, webhook, or job) now takes the
// parish's mapping lock in SHARED mode; a mapping save takes it EXCLUSIVE,
// after the books lock (lockMappingSave in finance/mappingWrite.js; the key
// must stay identical). A write waits for an in-flight save and then lands
// under the saved mapping; a save that starts second waits for open writes
// and then sees the committed line and refuses to restate it. Shared, so
// gifts never wait on each other, and a separate key from the books lock,
// so a period submission's frozen snapshot (D1) is unchanged.
const MAPPING_LOCK_FN = `
    CREATE OR REPLACE FUNCTION ochr_lock_parish_mappings()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_new integer;
      v_old integer;
    BEGIN
      IF TG_TABLE_NAME = 'ochr_payroll_shifts' THEN
        IF TG_OP <> 'DELETE' THEN
          SELECT organization_id INTO v_new FROM ochr_payroll_staff WHERE id = NEW.staff_id;
        END IF;
        IF TG_OP <> 'INSERT' THEN
          SELECT organization_id INTO v_old FROM ochr_payroll_staff WHERE id = OLD.staff_id;
        END IF;
      ELSE
        IF TG_OP <> 'DELETE' THEN v_new := NEW.organization_id; END IF;
        IF TG_OP <> 'INSERT' THEN v_old := OLD.organization_id; END IF;
      END IF;
      IF v_old IS NOT NULL AND v_new IS NOT NULL AND v_old > v_new THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('oc-books-mapping:' || v_new::text, 0));
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('oc-books-mapping:' || v_old::text, 0));
      ELSE
        IF v_old IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock_shared(hashtextextended('oc-books-mapping:' || v_old::text, 0));
        END IF;
        IF v_new IS NOT NULL AND v_new IS DISTINCT FROM v_old THEN
          PERFORM pg_advisory_xact_lock_shared(hashtextextended('oc-books-mapping:' || v_new::text, 0));
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$
  `

// Tables whose rows feed the mapped ledger lines. Staff carries pay_rate,
// which sets a payroll line's amount.
const MAPPING_LOCKED_TABLES = [
  ['ochr_donations', 'INSERT OR UPDATE OR DELETE'],
  ['ochr_donation_refunds', 'INSERT OR UPDATE OR DELETE'],
  ['ochr_payroll_shifts', 'INSERT OR UPDATE OR DELETE'],
  ['ochr_payroll_staff', 'UPDATE OR DELETE'],
]

// Totals before the cutover, per org, month, and account.
async function preCutoverTotals(db, cutoverOn) {
  const { rows } = await db.query(
    `SELECT organization_id, to_char(entry_date, 'YYYY-MM') AS month, account_code,
            SUM(amount)::text AS total
       FROM ochr_parish_ledger
      WHERE entry_date < $1::date
      GROUP BY organization_id, to_char(entry_date, 'YYYY-MM'), account_code`,
    [cutoverOn])
  return rows
}

// Lines dated on or after the cutover that a mapping can move, keyed
// without their account, with whether a submitted/approved period holds
// them.
async function lateLines(db, cutoverOn) {
  const { rows } = await db.query(
    `SELECT l.organization_id || '|' || l.source_type || '|' || l.source_id::text || '|'
              || l.entry_date::text || '|' || l.amount::text || '|' || COALESCE(l.memo, '') AS k,
            COALESCE(l.account_code, '') AS account_code,
            EXISTS (
              SELECT 1 FROM ochr_report_submissions s
               WHERE s.organization_id = l.organization_id
                 AND s.status IN ('submitted', 'approved')
                 AND l.entry_date BETWEEN s.period_start AND s.period_end
            ) AS frozen
       FROM ochr_parish_ledger l
      WHERE l.entry_date >= $1::date
        AND l.source_type IN ${LATE_SOURCES}`,
    [cutoverOn])
  const byKey = new Map()
  for (const r of rows) {
    const e = byKey.get(r.k) ?? { accounts: [], frozen: r.frozen }
    e.accounts.push(r.account_code)
    byKey.set(r.k, e)
  }
  for (const e of byKey.values()) e.accounts.sort()
  return byKey
}

export function lateMoves(before, after) {
  let moved = 0
  let frozen = 0
  for (const [k, prior] of before) {
    const next = after.get(k)?.accounts ?? []
    const same = prior.accounts.length === next.length
      && prior.accounts.every((a, i) => a === next[i])
    if (same) continue
    moved += 1
    if (prior.frozen) frozen += 1
  }
  return { moved, frozen }
}

export async function up() {
  console.log('Migration 132: effective-dated mappings — applying...')
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    // Atlas P2-a: a wait for any lock is bounded, so a long transaction makes
    // this fail and roll back (the deploy retries) instead of queueing every
    // finance read behind an ACCESS EXCLUSIVE request.
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    // Before any read, so the snapshot is taken after the locks: no gift,
    // refund, or shift can commit between the parity reads. Source tables
    // first, then mappings: a gift write that then reads the ledger view
    // takes them in that order too. SHARE ROW EXCLUSIVE (not SHARE) because
    // this transaction also adds triggers to them, so no lock upgrade.
    await client.query(
      `LOCK TABLE ochr_donations, ochr_donation_refunds, ochr_payroll_shifts, ochr_payroll_staff
         IN SHARE ROW EXCLUSIVE MODE`)
    await client.query(`LOCK TABLE ochr_coa_mappings IN ACCESS EXCLUSIVE MODE`)
    await applyAll(client)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function applyAll(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ochr_books_cutover (
      id BOOLEAN PRIMARY KEY DEFAULT TRUE,
      cutover_on DATE NOT NULL,
      CONSTRAINT ochr_books_cutover_one CHECK (id)
    )
  `)
  await db.query(`ALTER TABLE ochr_books_cutover ENABLE ROW LEVEL SECURITY`)
  const { rows: [prior] } = await db.query(
    `SELECT to_char(cutover_on, 'YYYY-MM-DD') AS c FROM ochr_books_cutover`)
  const staleCutover = prior?.c ?? null
  await db.query(CUTOVER_SQL)
  const { rows: [cut] } = await db.query(
    `SELECT to_char(cutover_on, 'YYYY-MM-DD') AS c FROM ochr_books_cutover`)
  if (!cut) throw new Error('books cutover was not stored')
  const cutoverOn = cut.c

  const before = await preCutoverTotals(db, cutoverOn)
  const lateBefore = await lateLines(db, cutoverOn)

  await db.query(`
    ALTER TABLE ochr_coa_mappings
      ADD COLUMN IF NOT EXISTS effective_from DATE NOT NULL DEFAULT '-infinity',
      ADD COLUMN IF NOT EXISTS superseded_on DATE,
      ADD COLUMN IF NOT EXISTS set_by TEXT NOT NULL DEFAULT 'parish'
  `)
  await db.query(`ALTER TABLE ochr_coa_mappings DROP CONSTRAINT IF EXISTS ochr_coa_mappings_organization_id_source_type_source_key_key`)
  await db.query(`ALTER TABLE ochr_coa_mappings DROP CONSTRAINT IF EXISTS ochr_coa_mappings_set_by_check`)
  await db.query(`
    ALTER TABLE ochr_coa_mappings
      ADD CONSTRAINT ochr_coa_mappings_set_by_check
      CHECK (set_by IN ('parish', 'diocese', 'template'))
  `)
  await db.query(`ALTER TABLE ochr_coa_mappings DROP CONSTRAINT IF EXISTS ochr_coa_mappings_supersede_check`)
  await db.query(`
    ALTER TABLE ochr_coa_mappings
      ADD CONSTRAINT ochr_coa_mappings_supersede_check
      CHECK (superseded_on IS NULL OR superseded_on >= effective_from)
  `)
  // Ledger R1, with the cutover chosen again above: template rows a failed
  // earlier run may have left at its stale date move to this cutover.
  if (staleCutover && staleCutover !== cutoverOn) {
    await db.query(
      `UPDATE ochr_coa_mappings
          SET effective_from = $1::date
        WHERE set_by = 'template' AND effective_from = $2::date AND superseded_on IS NULL`,
      [cutoverOn, staleCutover])
  }
  await db.query(`DROP INDEX IF EXISTS uq_coa_mappings_effective`)
  await db.query(`DROP INDEX IF EXISTS uq_coa_mappings_open`)
  // Exact, like the old UNIQUE and like resolution. Existing case
  // variants were already distinct rows, so this cannot fail on them.
  await db.query(`
    CREATE UNIQUE INDEX uq_coa_mappings_open
      ON ochr_coa_mappings (organization_id, source_type, source_key)
      WHERE superseded_on IS NULL
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_coa_mappings_resolution
      ON ochr_coa_mappings (organization_id, source_type, source_key, effective_from DESC, id DESC)
  `)

  await db.query(
    `INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
     SELECT NULL, '2320', 'Second Collections Payable (Pass-through)', 'liability', 'Payables', false, 55
      WHERE NOT EXISTS (
        SELECT 1 FROM ochr_coa_accounts WHERE organization_id IS NULL AND code = '2320')`)

  await db.query(`
    CREATE OR REPLACE FUNCTION ochr_mapping_account(p_org integer, p_type text, p_key text, p_on date)
    RETURNS text
    LANGUAGE sql
    STABLE
    AS $$
      SELECT m.account_code
        FROM ochr_coa_mappings m
       WHERE m.organization_id = p_org
         AND m.source_type = p_type
         AND m.source_key = p_key
         AND m.effective_from <= p_on
         AND (m.superseded_on IS NULL OR p_on < m.superseded_on)
       ORDER BY m.effective_from DESC, m.id DESC
       LIMIT 1
    $$
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS ochr_ledger_imports (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      idempotency_key  TEXT NOT NULL,
      as_of            DATE NOT NULL,
      row_count        INTEGER NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_ledger_imports_id_org_key UNIQUE (id, organization_id),
      CONSTRAINT ochr_ledger_imports_idem UNIQUE (organization_id, idempotency_key)
    )
  `)
  await db.query(`ALTER TABLE ochr_ledger_imports ENABLE ROW LEVEL SECURITY`)
  await db.query(`ALTER TABLE ochr_ledger_entries ADD COLUMN IF NOT EXISTS import_id BIGINT`)
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_ledger_entries_import_fk'
      ) THEN
        ALTER TABLE ochr_ledger_entries
          ADD CONSTRAINT ochr_ledger_entries_import_fk
          FOREIGN KEY (import_id, organization_id)
          REFERENCES ochr_ledger_imports (id, organization_id)
          ON DELETE RESTRICT;
      END IF;
    END $$
  `)
  await db.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ochr_ledger_imports`)
  await db.query(`
    CREATE TRIGGER ochr_organization_hold_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ochr_ledger_imports
    FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()
  `)

  const { rows: roles } = await db.query(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
  for (const table of ['ochr_books_cutover', 'ochr_ledger_imports']) {
    for (const { rolname } of roles) {
      await db.query(`REVOKE ALL ON ${table} FROM ${rolname}`)
    }
  }

  await db.query(LEDGER_VIEW)
  // SP-245 / SP-249: template seeding must reach held orgs too. Migration
  // 114's hold guard refuses INSERT on ochr_coa_mappings for those tenants
  // (23514), which aborts boot on any database that already has a held
  // parish. Same narrow, transaction-local pattern as 120/126: one client,
  // this one trigger on this one table, around this one system template
  // INSERT. The migration already holds ACCESS EXCLUSIVE on
  // ochr_coa_mappings, so no ordinary write can run while the guard is off;
  // ENABLE commits with the seed (any error rolls both back). The guard
  // function itself is untouched — runtime writes to a held org still fail.
  await db.query('ALTER TABLE ochr_coa_mappings DISABLE TRIGGER ochr_organization_hold_guard')
  await db.query(`
    INSERT INTO ochr_coa_mappings
      (organization_id, source_type, source_key, account_code, effective_from, set_by)
    SELECT o.id, 'donation_category', v.key, v.code, $1::date, 'template'
      FROM ochr_organizations o
      CROSS JOIN (VALUES ${DEFAULT_VALUES}) AS v(key, code)
     WHERE NOT EXISTS (
       SELECT 1 FROM ochr_coa_mappings m
        WHERE m.organization_id = o.id
          AND m.source_type = 'donation_category'
          AND m.source_key = v.key
          AND m.superseded_on IS NULL)
  `, [cutoverOn])
  await db.query('ALTER TABLE ochr_coa_mappings ENABLE TRIGGER ochr_organization_hold_guard')

  const after = await preCutoverTotals(db, cutoverOn)
  if (ledgerTotalsDiffer(before, after)) {
    throw new Error('mapping parity: ledger totals dated before the cutover differ; migration aborted')
  }
  const late = lateMoves(lateBefore, await lateLines(db, cutoverOn))
  if (late.frozen > 0) {
    throw new Error(`mapping parity: ${late.frozen} line(s) dated on or after the cutover sit in a submitted or approved period and would change account; migration aborted`)
  }
  if (late.moved > 0) {
    console.log(`  132: ${late.moved} line(s) dated on or after the cutover ${cutoverOn} follow the new mappings.`)
  }

  await db.query(`
    CREATE OR REPLACE FUNCTION ochr_seed_category_defaults()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO ochr_coa_mappings
        (organization_id, source_type, source_key, account_code, effective_from, set_by)
      SELECT NEW.id, 'donation_category', v.key, v.code,
             (SELECT cutover_on FROM ochr_books_cutover), 'template'
        FROM (VALUES ${DEFAULT_VALUES}) AS v(key, code)
       WHERE NOT EXISTS (
         SELECT 1 FROM ochr_coa_mappings m
          WHERE m.organization_id = NEW.id
            AND m.source_type = 'donation_category'
            AND m.source_key = v.key
            AND m.superseded_on IS NULL);
      RETURN NEW;
    END $$
  `)
  await db.query(MAPPING_LOCK_FN)
  for (const [table, events] of MAPPING_LOCKED_TABLES) {
    // CREATE OR REPLACE (PG 14+) takes SHARE ROW EXCLUSIVE, the lock this
    // transaction already holds; DROP TRIGGER would upgrade to ACCESS
    // EXCLUSIVE behind open readers.
    await db.query(`
      CREATE OR REPLACE TRIGGER ochr_lock_parish_mappings
      BEFORE ${events} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ochr_lock_parish_mappings()
    `)
  }
  await db.query(`DROP TRIGGER IF EXISTS ochr_seed_category_defaults ON ochr_organizations`)
  await db.query(`
    CREATE TRIGGER ochr_seed_category_defaults
    AFTER INSERT ON ochr_organizations
    FOR EACH ROW EXECUTE FUNCTION ochr_seed_category_defaults()
  `)

  const { rows: [acct] } = await db.query(
    `SELECT acct_type, assessable FROM ochr_coa_accounts
      WHERE organization_id IS NULL AND code = '2320'`)
  if (!acct || acct.acct_type !== 'liability' || acct.assessable !== false) {
    throw new Error('2320 must be a non-assessable liability')
  }
  const { rows: [fn] } = await db.query(
    `SELECT pg_get_functiondef('ochr_mapping_account(integer,text,text,date)'::regprocedure) AS def`)
  if (!fn || /lower\s*\(\s*m\.source_key/i.test(fn.def)) {
    throw new Error('mapping lookup must match source_key exactly')
  }
  const { rows: [idx] } = await db.query(
    `SELECT pg_get_indexdef('uq_coa_mappings_open'::regclass) AS def`)
  if (!idx || /lower\s*\(/i.test(idx.def)) {
    throw new Error('the open-mapping index must match source_key exactly')
  }
  const { rows: [view] } = await db.query(
    `SELECT pg_get_viewdef('ochr_parish_ledger'::regclass, true) AS def`)
  if (!view || !/ochr_mapping_account/.test(view.def) || !/ochr_donation_refunds/.test(view.def)
      || !/ochr_deposit_facts/.test(view.def)) {
    throw new Error('parish ledger view is missing the dated mapping or a refund/deposit branch')
  }
  const { rows: [fk] } = await db.query(
    `SELECT confdeltype FROM pg_constraint WHERE conname = 'ochr_ledger_entries_import_fk'`)
  if (!fk || fk.confdeltype !== 'r') throw new Error('import lines must restrict a batch delete')
  const { rows: [guard] } = await db.query(
    `SELECT 1 FROM pg_trigger WHERE tgname = 'ochr_organization_hold_guard'
       AND tgrelid = 'ochr_ledger_imports'::regclass AND NOT tgisinternal`)
  if (!guard) throw new Error('ledger imports are missing the organization hold guard')
  const { rows: [locks] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgname = 'ochr_lock_parish_mappings' AND NOT tgisinternal`)
  if (!locks || locks.n !== MAPPING_LOCKED_TABLES.length) {
    throw new Error('gift, refund, and payroll writes must take the parish mapping lock')
  }
}
