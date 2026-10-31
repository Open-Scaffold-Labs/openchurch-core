// 133 — parish hall and wedding hospitality (OC-CAT-1).
//
// Numbered 133 on purpose. 132 (effective-dated mappings, books) is on
// main and runs first; 133 follows it. Another branch owns 134.
//
// ADDITIVE. New tables only. Nothing here writes ochr_sacramental_records,
// ochr_deposit_facts, ochr_parish_ledger, or ochr_ledger_entries.
//
// A booking holds a room for a time. Milestone rows are expected amounts
// and due dates. Signing an agreement records the text the person signed.
// None of that collects money.
//
// GiST exclusion (btree_gist, tstzrange '[)') stops two held bookings of
// the same room in the same parish from overlapping, including a race
// the route's own check can lose. A cancelled hold drops out of the
// constraint. The parish Mass and the register are checked in the route;
// they are not rows in this table.

import pool from '../db.js'

const TABLES = [
  'ochr_cat_spaces',
  'ochr_cat_bookings',
  'ochr_cat_milestones',
  'ochr_cat_agreements',
  'ochr_cat_agreement_events',
  'ochr_cat_beos',
]

async function addConstraintIfMissing(name, ddl) {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
      ${ddl};
    END IF;
  END $$;`)
}

// SP-232. 133 was edited in place on leo/oc-cat-1 after 68ab9dca had
// already been applied to review databases. The migration ledger skips a
// name it has seen, so a DB that ran the earlier 133 never got the token
// index or the current trigger bodies. migrations/index.js calls
// ensureHallAgreementGuards() again when 133 is already in the ledger.
// It does not repair rows written under the earlier 133.
//
// Argus N7 / SP-244. That call runs on every boot, so it first reads the
// catalog and does nothing when the index, the three function bodies and
// the three triggers are all current: no DDL, no table locks. Only when
// something is missing or stale does it repair, and the repair is one
// transaction, so the guards are never absent to another session.
const GUARD_FUNCTIONS = [
  { name: 'ochr_cat_agreement_events_append_only', body: `
    BEGIN
      IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM ochr_organizations WHERE id = OLD.organization_id
      ) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'hall agreement events are append-only' USING ERRCODE = '55000';
    END
    ` },
  { name: 'ochr_cat_agreement_text_frozen', body: `
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM ochr_organizations WHERE id = OLD.organization_id) THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'a hall agreement is not deleted' USING ERRCODE = '55000';
      END IF;
      IF OLD.status IN ('sent', 'signed', 'declined', 'voided')
         AND (NEW.contract_en IS DISTINCT FROM OLD.contract_en
           OR NEW.contract_es IS DISTINCT FROM OLD.contract_es
           OR NEW.contract_sha256 IS DISTINCT FROM OLD.contract_sha256) THEN
        RAISE EXCEPTION 'a sent hall agreement is not rewritten' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    ` },
  { name: 'ochr_cat_milestones_frozen_after_send', body: `
    DECLARE
      sent boolean;
      bid bigint;
      oid integer;
    BEGIN
      IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM ochr_organizations WHERE id = OLD.organization_id
      ) THEN
        RETURN OLD;
      END IF;
      IF TG_OP = 'DELETE' THEN
        bid := OLD.booking_id;
        oid := OLD.organization_id;
      ELSE
        bid := NEW.booking_id;
        oid := NEW.organization_id;
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM ochr_cat_agreements a
         WHERE a.booking_id = bid AND a.organization_id = oid
           AND a.status IN ('sent', 'signed')
      ) INTO sent;
      IF sent AND TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'expected amounts stay once the agreement is sent' USING ERRCODE = '55000';
      END IF;
      IF sent AND TG_OP = 'UPDATE' AND (
           NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
        OR NEW.due_on IS DISTINCT FROM OLD.due_on
        OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW.label IS DISTINCT FROM OLD.label
      ) THEN
        RAISE EXCEPTION 'expected amounts stay once the agreement is sent' USING ERRCODE = '55000';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END
    ` },
]

// BEFORE UPDATE OR DELETE, FOR EACH ROW: ROW(1) | BEFORE(2) | DELETE(8) | UPDATE(16).
const GUARD_TRIGGER_TYPE = 27
const GUARD_TRIGGERS = [
  { name: 'ochr_cat_agreement_events_no_update', table: 'ochr_cat_agreement_events', fn: 'ochr_cat_agreement_events_append_only' },
  { name: 'ochr_cat_agreement_text_frozen', table: 'ochr_cat_agreements', fn: 'ochr_cat_agreement_text_frozen' },
  { name: 'ochr_cat_milestones_frozen_after_send', table: 'ochr_cat_milestones', fn: 'ochr_cat_milestones_frozen_after_send' },
]

const TOKEN_INDEX = 'ochr_cat_agreements_token_hash_key'

async function hallAgreementGuardsCurrent(db) {
  const { rows: [idx] } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indexrelid = to_regclass($1) AND i.indisunique AND i.indisvalid
          AND i.indrelid = 'ochr_cat_agreements'::regclass
     ) AS ok`, [TOKEN_INDEX])
  if (!idx.ok) return false
  for (const f of GUARD_FUNCTIONS) {
    const { rows } = await db.query(
      `SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)`, [`${f.name}()`])
    if (rows[0]?.prosrc !== f.body) return false
  }
  for (const t of GUARD_TRIGGERS) {
    const { rows } = await db.query(
      `SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass($1) AND tgname = $2 AND NOT tgisinternal
          AND tgfoid = to_regprocedure($3) AND tgtype = $4 AND tgenabled <> 'D'`,
      [t.table, t.name, `${t.fn}()`, GUARD_TRIGGER_TYPE])
    if (!rows.length) return false
  }
  return true
}

// Returns 'current' (nothing done), 'repaired', or false (tables absent).
export async function ensureHallAgreementGuards() {
  const { rows } = await pool.query(
    `SELECT to_regclass('ochr_cat_agreements') AS a, to_regclass('ochr_cat_agreement_events') AS e,
            to_regclass('ochr_cat_milestones') AS m`)
  if (!rows[0].a || !rows[0].e || !rows[0].m) return false
  if (await hallAgreementGuardsCurrent(pool)) return 'current'

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${TOKEN_INDEX}
        ON ochr_cat_agreements (token_hash)
        WHERE token_hash IS NOT NULL
    `)
    for (const f of GUARD_FUNCTIONS) {
      await client.query(`
    CREATE OR REPLACE FUNCTION ${f.name}()
    RETURNS trigger LANGUAGE plpgsql AS $fn$${f.body}$fn$`)
    }
    for (const t of GUARD_TRIGGERS) {
      await client.query(`DROP TRIGGER IF EXISTS ${t.name} ON ${t.table}`)
      await client.query(`CREATE TRIGGER ${t.name}
    BEFORE UPDATE OR DELETE ON ${t.table}
    FOR EACH ROW EXECUTE FUNCTION ${t.fn}()`)
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  return 'repaired'
}

export async function up() {
  console.log('Migration 133: parish-catering — applying...')

  await pool.query('CREATE EXTENSION IF NOT EXISTS btree_gist')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_cat_spaces (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      space_kind       TEXT NOT NULL,
      vertical_key     TEXT NOT NULL DEFAULT 'open-church',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_cat_spaces_kind_check CHECK (space_kind IN ('sanctuary', 'fellowship_hall', 'kitchen', 'pavilion')),
      CONSTRAINT ochr_cat_spaces_vertical_check CHECK (vertical_key = 'open-church'),
      CONSTRAINT ochr_cat_spaces_id_org_uniq UNIQUE (id, organization_id)
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_cat_bookings (
      id                   BIGSERIAL PRIMARY KEY,
      organization_id      INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      space_id             BIGINT NOT NULL,
      event_kind           TEXT NOT NULL,
      host_name            TEXT NOT NULL,
      occasion             TEXT,
      starts_at            TIMESTAMPTZ NOT NULL,
      ends_at              TIMESTAMPTZ NOT NULL,
      during               tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
      status               TEXT NOT NULL DEFAULT 'held',
      marriage_record_id   BIGINT,
      expected_guests      INTEGER,
      vertical_key         TEXT NOT NULL DEFAULT 'open-church',
      created_by_user_id   INTEGER,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cancelled_at         TIMESTAMPTZ,
      CONSTRAINT ochr_cat_bookings_time_check CHECK (ends_at > starts_at),
      CONSTRAINT ochr_cat_bookings_status_check CHECK (status IN ('held', 'cancelled')),
      CONSTRAINT ochr_cat_bookings_kind_check CHECK (event_kind IN (
        'wedding', 'rehearsal', 'fellowship_dinner', 'funeral_reception', 'quinceanera', 'hall_rental')),
      CONSTRAINT ochr_cat_bookings_vertical_check CHECK (vertical_key = 'open-church'),
      CONSTRAINT ochr_cat_bookings_id_org_uniq UNIQUE (id, organization_id)
    )
  `)

  await addConstraintIfMissing('ochr_cat_bookings_space_fk', `
    ALTER TABLE ochr_cat_bookings
      ADD CONSTRAINT ochr_cat_bookings_space_fk
      FOREIGN KEY (space_id, organization_id)
      REFERENCES ochr_cat_spaces (id, organization_id)`)
  await addConstraintIfMissing('ochr_cat_bookings_marriage_fk', `
    ALTER TABLE ochr_cat_bookings
      ADD CONSTRAINT ochr_cat_bookings_marriage_fk
      FOREIGN KEY (marriage_record_id, organization_id)
      REFERENCES ochr_sacramental_records (id, organization_id)`)
  await addConstraintIfMissing('ochr_cat_bookings_no_overlap', `
    ALTER TABLE ochr_cat_bookings
      ADD CONSTRAINT ochr_cat_bookings_no_overlap
      EXCLUDE USING gist (
        organization_id WITH =,
        space_id WITH =,
        during WITH &&
      ) WHERE (status = 'held')`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_cat_milestones (
      id                         BIGSERIAL PRIMARY KEY,
      organization_id            INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      booking_id                 BIGINT NOT NULL,
      kind                       TEXT NOT NULL,
      label                      TEXT NOT NULL,
      amount_cents               BIGINT NOT NULL,
      due_on                     DATE NOT NULL,
      status                     TEXT NOT NULL DEFAULT 'expected',
      event_deposit_payment_id   BIGINT,
      created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_cat_milestones_kind_check CHECK (kind IN (
        'date_hold', 'stipend_priest', 'stipend_organist', 'stipend_cantor',
        'stipend_altar_server', 'hall_rental', 'security_deposit')),
      CONSTRAINT ochr_cat_milestones_amount_check CHECK (amount_cents >= 0),
      CONSTRAINT ochr_cat_milestones_status_check CHECK (status = 'expected'),
      CONSTRAINT ochr_cat_milestones_id_org_uniq UNIQUE (id, organization_id),
      CONSTRAINT ochr_cat_milestones_booking_kind_uniq UNIQUE (organization_id, booking_id, kind)
    )
  `)
  await addConstraintIfMissing('ochr_cat_milestones_booking_fk', `
    ALTER TABLE ochr_cat_milestones
      ADD CONSTRAINT ochr_cat_milestones_booking_fk
      FOREIGN KEY (booking_id, organization_id)
      REFERENCES ochr_cat_bookings (id, organization_id) ON DELETE CASCADE`)
  await addConstraintIfMissing('ochr_cat_milestones_deposit_fk', `
    ALTER TABLE ochr_cat_milestones
      ADD CONSTRAINT ochr_cat_milestones_deposit_fk
      FOREIGN KEY (event_deposit_payment_id, organization_id)
      REFERENCES ochr_invoice_payments (id, organization_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_cat_agreements (
      id                 BIGSERIAL PRIMARY KEY,
      organization_id    INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      booking_id         BIGINT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'draft',
      contract_en        TEXT NOT NULL,
      contract_es        TEXT NOT NULL,
      contract_sha256    TEXT NOT NULL,
      token_hash         TEXT,
      token_sealed       TEXT,
      sent_at            TIMESTAMPTZ,
      signed_at          TIMESTAMPTZ,
      signer_name        TEXT,
      seal_sha256        TEXT,
      email_verified     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_cat_agreements_status_check CHECK (status IN ('draft', 'sent', 'signed', 'declined', 'voided')),
      CONSTRAINT ochr_cat_agreements_id_org_uniq UNIQUE (id, organization_id)
    )
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ochr_cat_agreements_one_open
      ON ochr_cat_agreements (organization_id, booking_id)
      WHERE status IN ('draft', 'sent', 'signed')
  `)
  await addConstraintIfMissing('ochr_cat_agreements_booking_fk', `
    ALTER TABLE ochr_cat_agreements
      ADD CONSTRAINT ochr_cat_agreements_booking_fk
      FOREIGN KEY (booking_id, organization_id)
      REFERENCES ochr_cat_bookings (id, organization_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_cat_agreement_events (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      agreement_id     BIGINT NOT NULL,
      kind             TEXT NOT NULL,
      payload          JSONB NOT NULL DEFAULT '{}',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_cat_agreement_events_id_org_uniq UNIQUE (id, organization_id)
    )
  `)
  await addConstraintIfMissing('ochr_cat_agreement_events_agreement_fk', `
    ALTER TABLE ochr_cat_agreement_events
      ADD CONSTRAINT ochr_cat_agreement_events_agreement_fk
      FOREIGN KEY (agreement_id, organization_id)
      REFERENCES ochr_cat_agreements (id, organization_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_cat_beos (
      id                BIGSERIAL PRIMARY KEY,
      organization_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      booking_id        BIGINT NOT NULL,
      table_count       INTEGER NOT NULL,
      chair_count       INTEGER NOT NULL,
      layout            TEXT NOT NULL DEFAULT '',
      kitchen_notes     TEXT NOT NULL DEFAULT '',
      allergen_notes    TEXT NOT NULL DEFAULT '',
      outside_caterer   TEXT NOT NULL DEFAULT '',
      guaranteed_count  INTEGER,
      locked_at         TIMESTAMPTZ,
      locked_by_user_id INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_cat_beos_counts_check CHECK (
        table_count >= 0 AND chair_count >= 0
        AND (guaranteed_count IS NULL OR guaranteed_count >= 0)),
      CONSTRAINT ochr_cat_beos_booking_uniq UNIQUE (organization_id, booking_id),
      CONSTRAINT ochr_cat_beos_id_org_uniq UNIQUE (id, organization_id)
    )
  `)
  await addConstraintIfMissing('ochr_cat_beos_booking_fk', `
    ALTER TABLE ochr_cat_beos
      ADD CONSTRAINT ochr_cat_beos_booking_fk
      FOREIGN KEY (booking_id, organization_id)
      REFERENCES ochr_cat_bookings (id, organization_id) ON DELETE CASCADE`)

  await ensureHallAgreementGuards()

  for (const table of TABLES) {
    await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    const { rows: roles } = await pool.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
    for (const { rolname } of roles) {
      await pool.query(`REVOKE ALL ON ${table} FROM ${rolname}`)
    }
    await pool.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ${table}`)
    await pool.query(`CREATE TRIGGER ochr_organization_hold_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)
  }

  const { rows: exclusion } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ochr_cat_bookings_no_overlap'`)
  if (!exclusion.length) throw new Error('133: ochr_cat_bookings_no_overlap was not created')
  if (!/tstzrange|during/i.test(exclusion[0].def)) {
    throw new Error('133: overlap constraint is not a time-range exclusion')
  }
  if (!/status/i.test(exclusion[0].def)) {
    throw new Error('133: overlap constraint is not limited to held bookings')
  }
  const { rows: found } = await pool.query(
    `SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1::text[])`, [TABLES])
  if (found.length !== TABLES.length || found.some(r => !r.relrowsecurity)) {
    throw new Error('133: a catering table is missing or has no row level security')
  }

  console.log('Migration 133: parish-catering — applied.')
}
