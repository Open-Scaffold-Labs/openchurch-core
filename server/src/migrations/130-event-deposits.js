// 130 — event deposits: append-only deposit facts, a 2300 Deposits Held
// account, and append-only invoice refund records.
//
// José, 25 Oct 2026, 8:30 PM PT, on Ledger's design note
// (landscape-patterns-2026-10-25/DEPOSITS-DESIGN.md) with Ledger's defaults.
// Follows 129-cutover-signoffs (#414). 2300 sits in rollup 'Deferred', so
// the cutover scoreboard's deposits line includes it with no change there.
//
// ADDITIVE ONLY. New template accounts, new tables, two composite-unique
// targets, a redefined projection view. No existing row is rewritten or
// deleted; the legacy refunded_at / refund_ref columns on
// ochr_invoice_payments stay exactly as they are and are no longer written.
//
//   ochr_deposit_facts — one row per money fact about a deposit:
//     received / applied / refunded / forfeited / reversal. amount > 0.
//     A mistake is corrected by a `reversal` row pointing at the original
//     (one reversal per fact), never by UPDATE or DELETE. A trigger keeps
//     Σ(applied + refunded + forfeited) ≤ Σ(received) per payment, net of
//     reversals, and Σ(received) ≤ the payment's own amount. Idempotency
//     key unique per org.
//   ochr_deposit_requests — staff ask, an admin who is not the requester
//     decides (refund / forfeit / reversal). A parish with exactly one
//     admin may approve its own request with a typed reason.
//   ochr_invoice_payment_refunds — refunds of non-deposit invoice payments,
//     previously recorded in place. Backfilled one-for-one from every row
//     with refunded_at set, keeping its timestamp and reference.
//   ochr_deposit_period_adjustments — a reversal whose original sits in a
//     submitted/approved diocesan period is dated TODAY and leaves a row
//     here for the chancery. assessable_impact is NULL (UNKNOWN): whether
//     deposits are assessable needs qualified review. The donation-keyed
//     ochr_period_adjustments table is not widened by this migration.
//     PRE-SUBMISSION BLOCKER (Ledger (b)): the diocesan rollup
//     (finance/periodAdjustmentRollup.js, routes/diocese.js) reads only
//     ochr_period_adjustments, so these rows are NOT yet visible to the
//     chancery. Applied income (e.g. 4210/4220/4710) can be assessable.
//     Wire this table into the rollup and settle flow before any diocesan
//     submission includes deposits.
//
// Ledger: ochr_parish_ledger (the projection, not a second book) gains a
// deposit branch derived from the facts. Single-sided like the donation
// rows: 2300 carries the held balance, income codes carry applied and
// forfeited amounts. Nothing is written to ochr_ledger_entries.
//
// Backfill of existing deposits: every is_deposit payment gets one
// `received` fact dated received_at; a deposit already refunded in place
// gets one full `refunded` fact dated refunded_at (approval_mode
// 'backfill'). Keys are deterministic, so a re-run inserts nothing.

import pool from '../db.js'

const F = 'ochr_deposit_facts'
const R = 'ochr_deposit_requests'
const IR = 'ochr_invoice_payment_refunds'
const PA = 'ochr_deposit_period_adjustments'

async function addConstraintIfMissing(name, ddl) {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
      ${ddl};
    END IF;
  END $$;`)
}

export const LEDGER_DEPOSIT_BRANCH = `
    UNION ALL

    SELECT
      f.organization_id,
      f.effective_date AS entry_date,
      x.account_code,
      x.amount::NUMERIC(12,2) AS amount,
      x.source_type,
      f.id AS source_id,
      'Event deposit' AS memo
    FROM ochr_deposit_facts f
    LEFT JOIN ochr_deposit_facts o
           ON o.id = f.reverses_fact_id AND o.organization_id = f.organization_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(o.kind, f.kind) AS kind,
             COALESCE(o.account_code, f.account_code) AS code,
             CASE WHEN f.kind = 'reversal' THEN -1 ELSE 1 END AS sgn
    ) b
    CROSS JOIN LATERAL (
      VALUES
        ('2300', b.sgn * CASE WHEN b.kind = 'received' THEN f.amount ELSE -f.amount END, 'deposit_held'),
        (b.code, b.sgn * f.amount, 'deposit_income')
    ) AS x(account_code, amount, source_type)
    WHERE x.source_type = 'deposit_held'
       OR b.kind IN ('applied', 'forfeited')
`

export async function up() {
  console.log('Migration 130: event-deposits — applying...')

  for (const [code, name, type, group, assessable, sort] of [
    ['2300', 'Deposits Held — Event Deposits', 'liability', 'Deferred', false, 65],
    // assessable FALSE until qualified review says otherwise (design note §10).
    ['4920', 'Forfeited Deposits', 'revenue', 'Other Revenue', false, 275],
  ]) {
    await pool.query(
      `INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
       SELECT NULL, $1::text, $2, $3, $4, $5, $6
        WHERE NOT EXISTS (SELECT 1 FROM ochr_coa_accounts WHERE organization_id IS NULL AND code = $1::text)`,
      [code, name, type, group, assessable, sort])
  }

  await addConstraintIfMissing('ochr_invoice_payments_id_org_uniq',
    `ALTER TABLE ochr_invoice_payments ADD CONSTRAINT ochr_invoice_payments_id_org_uniq UNIQUE (id, organization_id)`)
  await addConstraintIfMissing('ochr_invoice_lines_id_org_uniq',
    `ALTER TABLE ochr_invoice_lines ADD CONSTRAINT ochr_invoice_lines_id_org_uniq UNIQUE (id, organization_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${F} (
      id                  BIGSERIAL PRIMARY KEY,
      organization_id     INTEGER       NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      invoice_id          BIGINT        NOT NULL,
      payment_id          BIGINT        NOT NULL,
      invoice_line_id     BIGINT,
      kind                TEXT          NOT NULL,
      amount              NUMERIC(12,2) NOT NULL,
      account_code        TEXT          NOT NULL,
      effective_date      DATE          NOT NULL,
      reverses_fact_id    BIGINT,
      reason              TEXT,
      recorded_by_user_id INTEGER,
      recorded_by_name    TEXT,
      approved_by_user_id INTEGER,
      approved_by_name    TEXT,
      approval_mode       TEXT          NOT NULL DEFAULT 'none',
      request_id          BIGINT,
      idempotency_key     TEXT          NOT NULL,
      created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_deposit_facts_kind_check
        CHECK (kind IN ('received', 'applied', 'refunded', 'forfeited', 'reversal')),
      CONSTRAINT ochr_deposit_facts_amount_check CHECK (amount > 0),
      CONSTRAINT ochr_deposit_facts_code_check CHECK (account_code ~ '^[0-9]{4}$'),
      CONSTRAINT ochr_deposit_facts_reversal_link
        CHECK ((kind = 'reversal') = (reverses_fact_id IS NOT NULL)),
      CONSTRAINT ochr_deposit_facts_applied_line
        CHECK (kind <> 'applied' OR invoice_line_id IS NOT NULL),
      CONSTRAINT ochr_deposit_facts_approval_mode
        CHECK (approval_mode IN ('none', 'second_admin', 'single_admin', 'backfill')),
      CONSTRAINT ochr_deposit_facts_needs_approval
        CHECK (kind NOT IN ('refunded', 'forfeited', 'reversal') OR approval_mode <> 'none'),
      CONSTRAINT ochr_deposit_facts_second_person
        CHECK (approval_mode <> 'second_admin'
               OR (approved_by_user_id IS NOT NULL AND approved_by_user_id IS DISTINCT FROM recorded_by_user_id)),
      CONSTRAINT ochr_deposit_facts_reason_required
        CHECK (approval_mode IN ('none', 'backfill') OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),
      CONSTRAINT ochr_deposit_facts_idem_len
        CHECK (length(idempotency_key) > 0 AND length(idempotency_key) <= 160),
      CONSTRAINT ochr_deposit_facts_payment_fk FOREIGN KEY (payment_id, organization_id)
        REFERENCES ochr_invoice_payments (id, organization_id) ON DELETE NO ACTION,
      CONSTRAINT ochr_deposit_facts_invoice_fk FOREIGN KEY (invoice_id, organization_id)
        REFERENCES ochr_invoices (id, organization_id) ON DELETE NO ACTION,
      CONSTRAINT ochr_deposit_facts_line_fk FOREIGN KEY (invoice_line_id, organization_id)
        REFERENCES ochr_invoice_lines (id, organization_id),
      CONSTRAINT ochr_deposit_facts_recorded_by_fk FOREIGN KEY (recorded_by_user_id, organization_id)
        REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (recorded_by_user_id),
      CONSTRAINT ochr_deposit_facts_approved_by_fk FOREIGN KEY (approved_by_user_id, organization_id)
        REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (approved_by_user_id)
    )
  `)
  await addConstraintIfMissing('ochr_deposit_facts_id_org_uniq',
    `ALTER TABLE ${F} ADD CONSTRAINT ochr_deposit_facts_id_org_uniq UNIQUE (id, organization_id)`)
  await addConstraintIfMissing('ochr_deposit_facts_reverses_fk',
    `ALTER TABLE ${F} ADD CONSTRAINT ochr_deposit_facts_reverses_fk
       FOREIGN KEY (reverses_fact_id, organization_id) REFERENCES ${F} (id, organization_id) ON DELETE CASCADE`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_facts_idempotency
    ON ${F} (organization_id, idempotency_key)`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_facts_one_reversal
    ON ${F} (reverses_fact_id) WHERE reverses_fact_id IS NOT NULL`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deposit_facts_payment
    ON ${F} (organization_id, payment_id, effective_date)`)
  await pool.query(`ALTER TABLE ${F} ENABLE ROW LEVEL SECURITY`)

  // The cap and the shape of a reversal. Locks the payment row so two
  // writers on one deposit serialize even if a route forgets its lock.
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_deposit_facts_guard()
    RETURNS trigger AS $$
    DECLARE
      pay_amount NUMERIC(12,2);
      tgt        RECORD;
      tgt_kind   TEXT;
      received   NUMERIC(12,2);
      used       NUMERIC(12,2);
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'deposit facts are append-only; post a reversal instead'
          USING ERRCODE = '55000';
      END IF;
      IF TG_OP = 'DELETE' THEN
        -- Only a cascade from a parent (org / invoice / payment) may remove a
        -- fact; a direct DELETE is refused.
        IF pg_trigger_depth() <= 1 THEN
          RAISE EXCEPTION 'deposit facts are append-only; post a reversal instead'
            USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
      END IF;

      SELECT p.amount INTO pay_amount
        FROM ochr_invoice_payments p
       WHERE p.id = NEW.payment_id AND p.organization_id = NEW.organization_id
         AND p.invoice_id = NEW.invoice_id AND p.is_deposit
         FOR UPDATE;
      IF pay_amount IS NULL THEN
        RAISE EXCEPTION 'deposit payment %/% not found', NEW.payment_id, NEW.organization_id
          USING ERRCODE = '23503';
      END IF;

      tgt_kind := NEW.kind;
      IF NEW.kind = 'reversal' THEN
        SELECT * INTO tgt FROM ochr_deposit_facts
         WHERE id = NEW.reverses_fact_id AND organization_id = NEW.organization_id;
        IF tgt.id IS NULL OR tgt.payment_id <> NEW.payment_id OR tgt.kind = 'reversal'
           OR tgt.amount <> NEW.amount THEN
          RAISE EXCEPTION 'a reversal must undo one non-reversal fact on the same deposit, in full'
            USING ERRCODE = '23514';
        END IF;
        tgt_kind := tgt.kind;
      END IF;

      WITH eff AS (
        SELECT COALESCE(o.kind, f.kind) AS k,
               CASE WHEN f.kind = 'reversal' THEN -f.amount ELSE f.amount END AS a
          FROM ochr_deposit_facts f
          LEFT JOIN ochr_deposit_facts o ON o.id = f.reverses_fact_id
         WHERE f.payment_id = NEW.payment_id AND f.organization_id = NEW.organization_id
        UNION ALL
        SELECT tgt_kind, CASE WHEN NEW.kind = 'reversal' THEN -NEW.amount ELSE NEW.amount END
      )
      SELECT COALESCE(SUM(a) FILTER (WHERE k = 'received'), 0),
             COALESCE(SUM(a) FILTER (WHERE k IN ('applied', 'refunded', 'forfeited')), 0)
        INTO received, used FROM eff;

      IF received > pay_amount THEN
        RAISE EXCEPTION 'deposit received exceeds the payment amount' USING ERRCODE = '23514';
      END IF;
      IF used > received THEN
        RAISE EXCEPTION 'deposit over-applied: applied + refunded + forfeited exceeds received'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)
  await pool.query(`DROP TRIGGER IF EXISTS ochr_deposit_facts_guard ON ${F}`)
  await pool.query(`CREATE TRIGGER ochr_deposit_facts_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ${F}
    FOR EACH ROW EXECUTE FUNCTION ochr_deposit_facts_guard()`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${R} (
      id                   BIGSERIAL PRIMARY KEY,
      organization_id      INTEGER       NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      payment_id           BIGINT        NOT NULL,
      kind                 TEXT          NOT NULL,
      amount               NUMERIC(12,2) NOT NULL,
      target_fact_id       BIGINT,
      reason               TEXT          NOT NULL,
      status               TEXT          NOT NULL DEFAULT 'pending',
      requested_by_user_id INTEGER,
      requested_by_name    TEXT,
      decided_by_user_id   INTEGER,
      decided_by_name      TEXT,
      decided_at           TIMESTAMPTZ,
      decision_note        TEXT,
      approval_mode        TEXT,
      fact_id              BIGINT,
      idempotency_key      TEXT,
      created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_deposit_requests_idem_len
        CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 160),
      CONSTRAINT ochr_deposit_requests_kind_check CHECK (kind IN ('refund', 'forfeit', 'reversal')),
      CONSTRAINT ochr_deposit_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
      CONSTRAINT ochr_deposit_requests_amount_check CHECK (amount > 0),
      CONSTRAINT ochr_deposit_requests_reason_check CHECK (length(btrim(reason)) > 0),
      CONSTRAINT ochr_deposit_requests_target CHECK ((kind = 'reversal') = (target_fact_id IS NOT NULL)),
      CONSTRAINT ochr_deposit_requests_mode CHECK (approval_mode IS NULL OR approval_mode IN ('second_admin', 'single_admin')),
      CONSTRAINT ochr_deposit_requests_second_person
        CHECK (status <> 'approved' OR approval_mode = 'single_admin'
               OR decided_by_user_id IS DISTINCT FROM requested_by_user_id),
      CONSTRAINT ochr_deposit_requests_payment_fk FOREIGN KEY (payment_id, organization_id)
        REFERENCES ochr_invoice_payments (id, organization_id) ON DELETE CASCADE,
      CONSTRAINT ochr_deposit_requests_target_fk FOREIGN KEY (target_fact_id, organization_id)
        REFERENCES ${F} (id, organization_id) ON DELETE CASCADE,
      CONSTRAINT ochr_deposit_requests_fact_fk FOREIGN KEY (fact_id, organization_id)
        REFERENCES ${F} (id, organization_id) ON DELETE CASCADE,
      CONSTRAINT ochr_deposit_requests_requested_by_fk FOREIGN KEY (requested_by_user_id, organization_id)
        REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (requested_by_user_id),
      CONSTRAINT ochr_deposit_requests_decided_by_fk FOREIGN KEY (decided_by_user_id, organization_id)
        REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (decided_by_user_id)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deposit_requests_pending
    ON ${R} (organization_id, status, created_at)`)
  await pool.query(`ALTER TABLE ${R} ENABLE ROW LEVEL SECURITY`)
  // Double-submit guards (Ledger P2-2): an optional per-org idempotency key,
  // and at most one open refund/forfeit request per deposit and one open
  // reversal request per fact. Approval is still capped by the facts trigger.
  await pool.query(`ALTER TABLE ${R} ADD COLUMN IF NOT EXISTS idempotency_key TEXT`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_requests_idempotency
    ON ${R} (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_requests_one_open
    ON ${R} (organization_id, payment_id) WHERE status = 'pending' AND kind IN ('refund', 'forfeit')`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_requests_one_open_reversal
    ON ${R} (organization_id, target_fact_id) WHERE status = 'pending' AND kind = 'reversal'`)
  // Requests are frozen once decided, and while pending only the decision
  // columns may change (Ledger P3-1). Direct DELETE is refused.
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_deposit_requests_guard()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() <= 1 THEN
          RAISE EXCEPTION 'deposit requests cannot be deleted' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'a decided deposit request is frozen' USING ERRCODE = '55000';
      END IF;
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
         OR NEW.kind IS DISTINCT FROM OLD.kind
         OR NEW.amount IS DISTINCT FROM OLD.amount
         OR NEW.target_fact_id IS DISTINCT FROM OLD.target_fact_id
         OR NEW.reason IS DISTINCT FROM OLD.reason
         OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
         OR NEW.requested_by_name IS DISTINCT FROM OLD.requested_by_name
         OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'only the decision may change on a deposit request' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)
  await pool.query(`DROP TRIGGER IF EXISTS ochr_deposit_requests_guard ON ${R}`)
  await pool.query(`CREATE TRIGGER ochr_deposit_requests_guard
    BEFORE UPDATE OR DELETE ON ${R}
    FOR EACH ROW EXECUTE FUNCTION ochr_deposit_requests_guard()`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${IR} (
      id                  BIGSERIAL PRIMARY KEY,
      organization_id     INTEGER       NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      invoice_id          BIGINT        NOT NULL,
      payment_id          BIGINT        NOT NULL,
      amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      refunded_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      refund_ref          TEXT,
      source              TEXT          NOT NULL DEFAULT 'route' CHECK (source IN ('route', 'backfill')),
      recorded_by_user_id INTEGER,
      recorded_by_name    TEXT,
      created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_invoice_payment_refunds_payment_fk FOREIGN KEY (payment_id, organization_id)
        REFERENCES ochr_invoice_payments (id, organization_id) ON DELETE NO ACTION,
      CONSTRAINT ochr_invoice_payment_refunds_invoice_fk FOREIGN KEY (invoice_id, organization_id)
        REFERENCES ochr_invoices (id, organization_id) ON DELETE NO ACTION,
      CONSTRAINT ochr_invoice_payment_refunds_recorded_by_fk FOREIGN KEY (recorded_by_user_id, organization_id)
        REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (recorded_by_user_id)
    )
  `)
  // Today's semantic, kept: a non-deposit payment is refunded once, in full.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_payment_refunds_once
    ON ${IR} (organization_id, payment_id)`)
  await pool.query(`ALTER TABLE ${IR} ENABLE ROW LEVEL SECURITY`)
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_append_only_guard()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' OR pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
      END IF;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql
  `)
  await pool.query(`DROP TRIGGER IF EXISTS ochr_append_only_guard ON ${IR}`)
  await pool.query(`CREATE TRIGGER ochr_append_only_guard
    BEFORE UPDATE OR DELETE ON ${IR}
    FOR EACH ROW EXECUTE FUNCTION ochr_append_only_guard()`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${PA} (
      id                BIGSERIAL PRIMARY KEY,
      organization_id   INTEGER       NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      submission_id     BIGINT        NOT NULL,
      fact_id           BIGINT        NOT NULL,
      reversed_fact_id  BIGINT        NOT NULL,
      amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      assessable_impact NUMERIC(12,2),
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_deposit_period_adj_submission_fk FOREIGN KEY (submission_id, organization_id)
        REFERENCES ochr_report_submissions (id, organization_id) ON DELETE CASCADE,
      CONSTRAINT ochr_deposit_period_adj_fact_fk FOREIGN KEY (fact_id, organization_id)
        REFERENCES ${F} (id, organization_id) ON DELETE CASCADE,
      CONSTRAINT ochr_deposit_period_adj_reversed_fk FOREIGN KEY (reversed_fact_id, organization_id)
        REFERENCES ${F} (id, organization_id) ON DELETE CASCADE
    )
  `)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_period_adj_once
    ON ${PA} (submission_id, fact_id)`)
  await pool.query(`ALTER TABLE ${PA} ENABLE ROW LEVEL SECURITY`)

  // Money rows are never removed by deleting their payment or invoice
  // (Ledger P2-3): NO ACTION, not CASCADE. Re-applied for databases that
  // ran an earlier draft of this migration. NO ACTION (checked at statement
  // end) still lets an organization delete remove everything in one go.
  for (const [table, name, cols, ref] of [
    [F, 'ochr_deposit_facts_payment_fk', 'payment_id', 'ochr_invoice_payments'],
    [F, 'ochr_deposit_facts_invoice_fk', 'invoice_id', 'ochr_invoices'],
    [IR, 'ochr_invoice_payment_refunds_payment_fk', 'payment_id', 'ochr_invoice_payments'],
    [IR, 'ochr_invoice_payment_refunds_invoice_fk', 'invoice_id', 'ochr_invoices'],
  ]) {
    const { rows: [c] } = await pool.query(`SELECT confdeltype FROM pg_constraint WHERE conname = $1`, [name])
    if (c && c.confdeltype !== 'a') {
      await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`)
      await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (${cols}, organization_id)
        REFERENCES ${ref} (id, organization_id) ON DELETE NO ACTION`)
    }
  }

  const { rows: roles } = await pool.query(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
  for (const t of [F, R, IR, PA]) {
    for (const { rolname } of roles) await pool.query(`REVOKE ALL ON ${t} FROM ${rolname}`)
    await pool.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ${t}`)
    await pool.query(`CREATE TRIGGER ochr_organization_hold_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${t}
      FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)
  }

  // ---- backfill: history preserved, deterministic keys ----
  await pool.query(`
    INSERT INTO ${IR} (organization_id, invoice_id, payment_id, amount, refunded_at, refund_ref, source)
    SELECT p.organization_id, p.invoice_id, p.id, p.amount, p.refunded_at, p.refund_ref, 'backfill'
      FROM ochr_invoice_payments p
     WHERE p.refunded_at IS NOT NULL AND NOT p.is_deposit
    ON CONFLICT (organization_id, payment_id) DO NOTHING
  `)
  await pool.query(`
    INSERT INTO ${F} (organization_id, invoice_id, payment_id, kind, amount, account_code,
                      effective_date, approval_mode, idempotency_key, recorded_by_user_id, created_at)
    SELECT p.organization_id, p.invoice_id, p.id, 'received', p.amount, '2300',
           p.received_at::date, 'none', 'backfill:received:' || p.id,
           (SELECT u.id FROM ochr_users u WHERE u.id = p.received_by AND u.organization_id = p.organization_id),
           p.created_at
      FROM ochr_invoice_payments p
     WHERE p.is_deposit
       AND NOT EXISTS (SELECT 1 FROM ${F} f WHERE f.payment_id = p.id AND f.organization_id = p.organization_id
                          AND f.kind = 'received')
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  `)
  await pool.query(`
    INSERT INTO ${F} (organization_id, invoice_id, payment_id, kind, amount, account_code,
                      effective_date, approval_mode, idempotency_key, reason)
    SELECT p.organization_id, p.invoice_id, p.id, 'refunded', p.amount, '2300',
           p.refunded_at::date, 'backfill', 'backfill:refunded:' || p.id,
           'Refund recorded before migration 130' || COALESCE(' (ref ' || p.refund_ref || ')', '')
      FROM ochr_invoice_payments p
     WHERE p.is_deposit AND p.refunded_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ${F} f WHERE f.payment_id = p.id AND f.organization_id = p.organization_id
                          AND f.kind = 'refunded')
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  `)

  // 132 defines ochr_mapping_account and replaces this view. A test that
  // re-runs 130 after that must not install the older view again: the
  // older join has no effective date, so a template row would apply to a
  // gift dated before it. The first run of 130, before that function
  // exists, still installs the view below.
  const { rows: datedMappings } = await pool.query(
    `SELECT 1 FROM pg_proc WHERE proname = 'ochr_mapping_account'`)
  if (!datedMappings.length) await pool.query(`
    CREATE OR REPLACE VIEW ochr_parish_ledger WITH (security_invoker = true) AS
    SELECT
      le.organization_id, le.entry_date, le.account_code, le.amount,
      le.source_type, le.id AS source_id, le.memo
    FROM ochr_ledger_entries le

    UNION ALL

    SELECT
      d.organization_id,
      d.date::date AS entry_date,
      COALESCE(fm.account_code, cm.account_code, '4420') AS account_code,
      d.amount AS amount,
      'donation' AS source_type,
      d.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d
    LEFT JOIN ochr_coa_mappings fm
           ON fm.organization_id = d.organization_id
          AND fm.source_type = 'fund'
          AND d.fund_id IS NOT NULL
          AND fm.source_key = d.fund_id::text
    LEFT JOIN ochr_coa_mappings cm
           ON cm.organization_id = d.organization_id
          AND cm.source_type = 'donation_category'
          AND cm.source_key = COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized')

    UNION ALL

    SELECT
      r.organization_id,
      d.date::date AS entry_date,
      COALESCE(fm.account_code, cm.account_code, '4420') AS account_code,
      (-r.amount)::NUMERIC(12,2) AS amount,
      'donation_refund' AS source_type,
      r.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donation_refunds r
    JOIN ochr_donations d
      ON d.id = r.donation_id AND d.organization_id = r.organization_id
    LEFT JOIN ochr_coa_mappings fm
           ON fm.organization_id = d.organization_id
          AND fm.source_type = 'fund'
          AND d.fund_id IS NOT NULL
          AND fm.source_key = d.fund_id::text
    LEFT JOIN ochr_coa_mappings cm
           ON cm.organization_id = d.organization_id
          AND cm.source_type = 'donation_category'
          AND cm.source_key = COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized')
    WHERE r.status = 'posted'

    UNION ALL

    SELECT
      d.organization_id,
      d.date::date AS entry_date,
      COALESCE(fm.account_code, cm.account_code, '4420') AS account_code,
      (-d.amount)::NUMERIC(12,2) AS amount,
      'donation_refund' AS source_type,
      d.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d
    LEFT JOIN ochr_coa_mappings fm
           ON fm.organization_id = d.organization_id
          AND fm.source_type = 'fund'
          AND d.fund_id IS NOT NULL
          AND fm.source_key = d.fund_id::text
    LEFT JOIN ochr_coa_mappings cm
           ON cm.organization_id = d.organization_id
          AND cm.source_type = 'donation_category'
          AND cm.source_key = COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized')
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
      COALESCE(m.account_code, '5120') AS account_code,
      (sh.hours * s.pay_rate)::NUMERIC(12,2) AS amount,
      'payroll' AS source_type,
      sh.id AS source_id,
      s.name AS memo
    FROM ochr_payroll_shifts sh
    JOIN ochr_payroll_staff s ON s.id = sh.staff_id
    LEFT JOIN ochr_coa_mappings m
           ON m.organization_id = s.organization_id
          AND m.source_type = 'payroll'
          AND m.source_key = 'wages'
${LEDGER_DEPOSIT_BRANCH}
  `)

  // ---- self-checks ----
  const { rows: missed } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM ochr_invoice_payments p WHERE p.refunded_at IS NOT NULL AND NOT p.is_deposit
          AND NOT EXISTS (SELECT 1 FROM ${IR} r WHERE r.payment_id = p.id)) AS refunds,
      (SELECT COUNT(*) FROM ochr_invoice_payments p WHERE p.is_deposit
          AND NOT EXISTS (SELECT 1 FROM ${F} f WHERE f.payment_id = p.id AND f.kind = 'received')) AS deposits
  `)
  if (Number(missed[0].refunds) || Number(missed[0].deposits)) {
    throw new Error(`130: backfill incomplete (${missed[0].refunds} refunds, ${missed[0].deposits} deposits)`)
  }
  for (const name of ['ochr_deposit_facts_payment_fk', 'ochr_deposit_facts_line_fk',
    'ochr_deposit_requests_payment_fk', 'ochr_invoice_payment_refunds_payment_fk']) {
    const { rows: fk } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name])
    if (!fk.length || !/organization_id/.test(fk[0].def)) {
      throw new Error(`130: ${name} is not tenant-composite`)
    }
  }
  const { rows: v } = await pool.query(`SELECT pg_get_viewdef('ochr_parish_ledger', true) AS def`)
  if (!/ochr_deposit_facts/.test(v[0]?.def || '') || !/ochr_donation_refunds/.test(v[0]?.def || '')) {
    throw new Error('130: parish ledger lost a branch')
  }

  console.log('Migration 130: event-deposits — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
