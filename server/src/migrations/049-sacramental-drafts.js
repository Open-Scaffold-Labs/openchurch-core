// ochr_sacramental_drafts (SAC.6) — the register-digitization staging
// area. Incoming rows from a CSV export or an OCR pass over the paper
// register land here as DRAFTS, get reviewed side-by-side against the
// structured form, and only on explicit commit become rows in the
// permanent register (ochr_sacramental_records). Nothing writes to the
// register without a human confirming it — the register is canonical.
//
//   raw_payload — the original unstructured row, kept verbatim for the
//                 side-by-side review (and as provenance after commit).
//   draft       — the structured candidate (same fields the sacraments
//                 POST accepts). Editable until committed/discarded.
//   status      — pending → committed | discarded. Committed drafts
//                 keep a pointer to the register row they produced.

import pool from '../db.js'

export async function up() {
  console.log('Migration 049: sacramental-drafts — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_sacramental_drafts (
      id                  BIGSERIAL PRIMARY KEY,
      organization_id     INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      source              TEXT NOT NULL DEFAULT 'csv'
                            CHECK (source IN ('csv', 'ocr', 'manual')),
      raw_payload         JSONB NOT NULL DEFAULT '{}',
      draft               JSONB NOT NULL DEFAULT '{}',
      status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'committed', 'discarded')),
      committed_record_id BIGINT REFERENCES ochr_sacramental_records(id) ON DELETE SET NULL,
      created_by          INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sacramental_drafts_org_status
      ON ochr_sacramental_drafts(organization_id, status)
  `)

  // RLS enabled with no policy — the ochr_* invariant (tenancy enforced
  // in the route layer; advisors flag rls_disabled_in_public otherwise).
  await pool.query(`ALTER TABLE ochr_sacramental_drafts ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 049: sacramental-drafts — applied.')
}
