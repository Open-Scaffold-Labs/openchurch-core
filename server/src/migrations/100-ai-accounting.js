// Durable AI accounting and bounded audit — the two tables OSL AI requires
// before a production adoption (osl-ai docs/ADOPTION.md step 4).
//
// WHY THIS EXISTS SEPARATELY FROM ochr_ai_usage. 006 counts generations so a
// parish can be shown "3 of 25 this month". That is a product quota, recorded
// AFTER a successful call — a call that fails, times out, or returns an
// unknowable cost leaves no trace and bills nothing. The shared contract needs
// the opposite guarantee: a claim taken BEFORE dispatch, held when the outcome
// is unknown, and never released just because a client gave up waiting. Those
// are different questions about different moments, so they are different
// tables. 006 stays exactly as it is.
//
// MICRODOLLARS, NOT NUMERIC. The contract specifies integer microdollars
// internally, reservations rounded up and limits rounded down, and requires
// that negative, NaN and infinite costs cannot be stored. BIGINT with CHECK
// constraints gives all of that; a float column gives none of it.
//
// This migration adds no policy and no keys. It is storage for a client that
// does not exist yet, deliberately: the ledger interface is fully specified,
// so it can be built and proven before the package is adoptable.

import pool from '../db.js'

const LEDGER = 'ochr_ai_ledger'
const AUDIT = 'ochr_ai_audit'

export async function up() {
  console.log('Migration 100: ai-accounting — applying...')

  // ---------------------------------------------------------------- ledger --
  //
  // reservation_id is the PRIMARY KEY and it is never recycled. The contract:
  // "Reject duplicate IDs even after settlement to avoid repeat model billing."
  // A UNIQUE index on a settled-rows-excluded partial index would let a settled
  // id be reserved a second time, which is exactly the double-billing this is
  // meant to prevent — so the constraint covers every row for all time.
  //
  // Scope mirrors the contract's `{application, environment, tenantId?,
  // publicSessionId?}`. OpenChurch's tenant IS the organization, so tenantId
  // maps to organization_id and carries a real foreign key; a public session
  // has no organization and stores its opaque id instead. Exactly one of the
  // two is present, enforced below rather than trusted from the caller.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER} (
      reservation_id    TEXT PRIMARY KEY,
      application       TEXT   NOT NULL,
      environment       TEXT   NOT NULL,
      organization_id   INTEGER REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      public_session_id TEXT,
      request_id        TEXT   NOT NULL,
      capability        TEXT   NOT NULL,

      -- Claimed before dispatch. Rounded up by the caller; never null.
      reserved_micros   BIGINT NOT NULL,

      -- Written once by settle(). NULL means "still held": either in flight,
      -- or settled with an unknown cost, which the contract says conservatively
      -- keeps the reserved amount rather than charging zero.
      settled_micros    BIGINT,
      outcome           TEXT,

      -- Reported usage, nullable because missing usage is unknown, never zero.
      input_tokens      BIGINT,
      output_tokens     BIGINT,

      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      settled_at        TIMESTAMPTZ,

      -- Costs cannot be negative. BIGINT already excludes NaN and infinity,
      -- which is half the reason the amounts are integers at all.
      CONSTRAINT ochr_ai_ledger_reserved_nonneg CHECK (reserved_micros >= 0),
      CONSTRAINT ochr_ai_ledger_settled_nonneg  CHECK (settled_micros IS NULL OR settled_micros >= 0),

      -- Exactly one identity, matching the contract's context rule.
      CONSTRAINT ochr_ai_ledger_one_identity CHECK (
        (organization_id IS NOT NULL AND public_session_id IS NULL)
        OR (organization_id IS NULL AND public_session_id IS NOT NULL)
      ),

      -- A settled row names its outcome and when. Half-settled is not a state.
      CONSTRAINT ochr_ai_ledger_settlement_whole CHECK (
        (settled_at IS NULL AND outcome IS NULL)
        OR (settled_at IS NOT NULL AND outcome IS NOT NULL)
      )
    )
  `)

  // "What is this scope currently holding?" — the question a budget check asks
  // on every call, so it is an index rather than a scan. Held rows only.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_ledger_open_by_scope
      ON ${LEDGER} (application, environment, organization_id, public_session_id)
      WHERE settled_at IS NULL
  `)

  // Request-scoped lookups: duplicate-request detection reads by request_id
  // within a scope, not by reservation id.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_ledger_request
      ON ${LEDGER} (application, environment, request_id)
  `)

  // ----------------------------------------------------------------- audit --
  //
  // BOUNDED METADATA ONLY. The contract is explicit that audit events carry
  // identity, routing, usage, event name, error code and versions — and NOT
  // prompt, response, source text, credentials, or raw provider error text.
  // There is deliberately no column here that could hold any of those. A
  // schema that cannot store a prompt cannot leak one, which is a stronger
  // guarantee than a rule saying not to.
  //
  // source_ids records WHICH sources were named, by id and version only. The
  // contract is equally explicit that this is not a claim of verified
  // citation, and the column name should not grow into implying one.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${AUDIT} (
      id                BIGSERIAL PRIMARY KEY,
      application       TEXT   NOT NULL,
      environment       TEXT   NOT NULL,
      organization_id   INTEGER REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      public_session_id TEXT,
      actor_id          INTEGER,

      request_id        TEXT   NOT NULL,
      event             TEXT   NOT NULL,
      capability        TEXT,
      route_id          TEXT,
      provider          TEXT,
      requested_model   TEXT,
      reported_model    TEXT,
      finish_reason     TEXT,
      error_code        TEXT,

      data_class        TEXT,
      policy_version    TEXT,
      prompt_version    TEXT,
      contract_version  TEXT,

      input_tokens      BIGINT,
      output_tokens     BIGINT,
      cost_micros       BIGINT,
      cost_estimated    BOOLEAN,
      duration_ms       INTEGER,

      source_ids        JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT ochr_ai_audit_one_identity CHECK (
        (organization_id IS NOT NULL AND public_session_id IS NULL)
        OR (organization_id IS NULL AND public_session_id IS NOT NULL)
      ),
      CONSTRAINT ochr_ai_audit_data_class CHECK (
        data_class IS NULL OR data_class IN ('public', 'internal', 'restricted')
      ),
      CONSTRAINT ochr_ai_audit_cost_nonneg CHECK (cost_micros IS NULL OR cost_micros >= 0),

      -- An actor belongs to the organization the event is recorded against.
      -- A single-column FK to ochr_users would let this row name a user from
      -- ANOTHER parish, which in an audit table is the one thing it must not
      -- be able to do. Composite FK (migration 071's pattern), with the
      -- column-scoped SET NULL so a deleted user does not also null the
      -- organization and break the one-identity rule below.
      CONSTRAINT ochr_ai_audit_actor_fk
        FOREIGN KEY (actor_id, organization_id)
        REFERENCES ochr_users(id, organization_id) ON DELETE SET NULL (actor_id),

      -- MATCH SIMPLE means the composite FK above is NOT enforced when
      -- organization_id is null, which is exactly the public-session row. So
      -- say plainly that an anonymous session has no actor — the contract
      -- already requires a tenant wherever an actor is present.
      CONSTRAINT ochr_ai_audit_actor_needs_org CHECK (
        actor_id IS NULL OR organization_id IS NOT NULL
      )
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_audit_scope_time
      ON ${AUDIT} (application, environment, organization_id, created_at DESC)
  `)

  // Every ochr_* table carries RLS, enable-only and no policies: the app
  // connects as the owner, so this changes no behaviour today and leaves
  // nothing for a later audit to find missing.
  await pool.query(`ALTER TABLE ${LEDGER} ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE ${AUDIT}  ENABLE ROW LEVEL SECURITY`)

  // Self-assertion. A half-applied migration leaves the schema and the file
  // disagreeing, and here the disagreement is invisible until the first
  // double-billed request.
  for (const t of [LEDGER, AUDIT]) {
    const { rows } = await pool.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = $1 AND relkind = 'r'`, [t])
    if (!rows.length) throw new Error(`100: ${t} was not created`)
    if (!rows[0].relrowsecurity) throw new Error(`100: ${t} has no row level security`)
  }
  const { rows: pk } = await pool.query(`
    SELECT 1 FROM pg_constraint
     WHERE conrelid = $1::regclass AND contype = 'p'`, [LEDGER])
  if (!pk.length) {
    throw new Error(`100: ${LEDGER} has no primary key — a duplicate reservation id could bill twice`)
  }

  console.log('Migration 100: ai-accounting — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
