// 068 — Parish invoices: the Johnson wedding owes $800, gently.
//
// The invoice is the missing entity between the fee schedule (067) and the
// money tables. Design constraints, in order of importance:
//
//   1. Waivers are first-class. Pastors reduce or forgive fees for hardship
//      constantly; the schema records the mercy (amount, reason, who) instead
//      of forcing a fake discount line. 'waived' is a terminal status equal
//      in dignity to 'paid'.
//   2. Invoices attach to the EVENT, not just the payer. A wedding books
//      6–12 months out; the invoice hangs off the calendar_events row so
//      deposits, the ceremony date, and the balance all read from one place.
//      Both links are optional — a hall rental to a non-member needs neither
//      a client row nor (yet) an event.
//   3. Lines carry their own ledger routing (account_code / fund_id,
//      defaulted from the fee item but overridable) because one invoice
//      legitimately splits: church use → facility revenue, musician → pass-
//      through liability, Mass stipend → canonically restricted. The
//      chancery-facing report reads the lines, not the invoice.
//   4. Tenant guards from day one: composite FKs prove payer, event, and
//      fee item all belong to the invoice's own org (the 061 lesson,
//      applied before the bug instead of after).
//
// Numbers: invoice_no is NULL while draft; assigned sequentially per org at
// issue time (route layer, FOR UPDATE on the org counter from 067).
// UNIQUE (organization_id, invoice_no) makes duplicates impossible without
// forbidding the NULL drafts. total = subtotal − waived_amount is enforced
// as a CHECK rather than a generated column so the route layer stays the
// single writer of intent.

import pool from '../db.js'

async function addConstraintIfMissing(name, ddl) {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
      ${ddl};
    END IF;
  END $$;`)
}

export async function up() {
  console.log('Migration 068: parish-invoices — applying...')

  // ochr_calendar_events needs to be a composite-FK target; 044 covered the
  // join tables but not this parent. Same guarded pattern.
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_calendar_events_id_org_uniq') THEN
      ALTER TABLE ochr_calendar_events ADD CONSTRAINT ochr_calendar_events_id_org_uniq UNIQUE (id, organization_id);
    END IF;
  END $$;`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_invoices (
      id                 BIGSERIAL PRIMARY KEY,
      organization_id    INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      invoice_no         TEXT,
      title              TEXT NOT NULL,
      category           TEXT NOT NULL DEFAULT 'other'
                           CHECK (category IN (
                             'wedding', 'funeral', 'baptism', 'quinceanera',
                             'facility', 'stipend', 'other'
                           )),
      client_id          INTEGER,
      payer_name         TEXT NOT NULL,
      payer_email        TEXT,
      payer_phone        TEXT,
      calendar_event_id  INTEGER,
      status             TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN (
                             'draft', 'issued', 'partially_paid',
                             'paid', 'waived', 'cancelled'
                           )),
      subtotal           NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
      waived_amount      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (waived_amount >= 0),
      total              NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
      amount_paid        NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
      waiver_reason      TEXT,
      waived_by          INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      due_date           DATE,
      issued_at          TIMESTAMPTZ,
      notes              TEXT,
      created_by         INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (total = subtotal - waived_amount),
      CHECK (waived_amount <= subtotal)
    )
  `)

  // Sequential numbers unique per org; drafts (NULL) exempt by definition.
  await addConstraintIfMissing('ochr_invoices_org_no_uniq',
    `ALTER TABLE ochr_invoices ADD CONSTRAINT ochr_invoices_org_no_uniq UNIQUE (organization_id, invoice_no)`)

  // Tenant-proof the payer and event references (parents already carry
  // id_org_uniq: clients via 044, calendar_events above).
  await addConstraintIfMissing('ochr_invoices_client_org_fk',
    `ALTER TABLE ochr_invoices ADD CONSTRAINT ochr_invoices_client_org_fk
       FOREIGN KEY (client_id, organization_id)
       REFERENCES ochr_clients(id, organization_id) ON DELETE SET NULL`)
  await addConstraintIfMissing('ochr_invoices_event_org_fk',
    `ALTER TABLE ochr_invoices ADD CONSTRAINT ochr_invoices_event_org_fk
       FOREIGN KEY (calendar_event_id, organization_id)
       REFERENCES ochr_calendar_events(id, organization_id) ON DELETE SET NULL`)

  // Composite-FK target for lines and payments.
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_invoices_id_org_uniq') THEN
      ALTER TABLE ochr_invoices ADD CONSTRAINT ochr_invoices_id_org_uniq UNIQUE (id, organization_id);
    END IF;
  END $$;`)

  // The workbench view (org + status), the event drawer, and the payer's
  // history on MemberDetail.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoices_org_status ON ochr_invoices(organization_id, status)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoices_org_event  ON ochr_invoices(organization_id, calendar_event_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoices_org_client ON ochr_invoices(organization_id, client_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_invoice_lines (
      id                 BIGSERIAL PRIMARY KEY,
      organization_id    INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      invoice_id         BIGINT NOT NULL,
      fee_schedule_id    BIGINT,
      description        TEXT NOT NULL,
      qty                NUMERIC(6,2) NOT NULL DEFAULT 1 CHECK (qty > 0),
      unit_amount        NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (unit_amount >= 0),
      amount             NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
      pass_through       BOOLEAN NOT NULL DEFAULT FALSE,
      payee              TEXT,
      account_code       TEXT,
      fund_id            BIGINT REFERENCES ochr_funds(id) ON DELETE SET NULL,
      sort_order         INTEGER NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (amount = ROUND(qty * unit_amount, 2))
    )
  `)

  await addConstraintIfMissing('ochr_invoice_lines_invoice_org_fk',
    `ALTER TABLE ochr_invoice_lines ADD CONSTRAINT ochr_invoice_lines_invoice_org_fk
       FOREIGN KEY (invoice_id, organization_id)
       REFERENCES ochr_invoices(id, organization_id) ON DELETE CASCADE`)
  await addConstraintIfMissing('ochr_invoice_lines_fee_org_fk',
    `ALTER TABLE ochr_invoice_lines ADD CONSTRAINT ochr_invoice_lines_fee_org_fk
       FOREIGN KEY (fee_schedule_id, organization_id)
       REFERENCES ochr_fee_schedules(id, organization_id) ON DELETE SET NULL`)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON ochr_invoice_lines(invoice_id, sort_order)`)

  await pool.query(`ALTER TABLE ochr_invoices      ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE ochr_invoice_lines ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 068: parish-invoices — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
