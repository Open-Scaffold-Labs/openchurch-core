import pool from '../db.js'

// Durable receipt of every verified billing/giving webhook event (Stage 6).
//
// A verified event is written here BEFORE it is applied and before the
// provider is told it was received. Applying it may be refused — an
// organization on hold refuses ordinary business writes (migration 114) —
// and a provider's retries end; this row is what remains, for
// reconciliation, either way. One row per provider event id (idempotent).
//
// Not under the HOLD write guard on purpose: recording that a provider sent
// an event changes no parish data and is exactly what must still happen for
// a held organization. organization_id is informational (the organization
// the event names, when it names one); applying the event goes through the
// guarded tables like any other write.
//
// No retention period is set here; none has been decided.
export async function up() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_billing_event_receipts (
      id               BIGSERIAL PRIMARY KEY,
      provider         TEXT NOT NULL,
      event_id         TEXT NOT NULL,
      event_type       TEXT,
      organization_id  INTEGER REFERENCES ochr_organizations(id) ON DELETE SET NULL,
      payload          JSONB NOT NULL,
      -- received: stored, not yet attempted. applying: claimed by one
      -- worker (claimed_at is the lease). applied: done, or nothing to do.
      -- deferred: verified but not applied because billing is not switched
      -- on (stub); re-processed once it is. held: the organization is on
      -- hold. failed: the apply raised; the provider redelivers and the
      -- operator can re-process.
      status           TEXT NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received', 'applying', 'applied', 'deferred', 'held', 'failed')),
      claimed_at       TIMESTAMPTZ,
      attempts         INTEGER NOT NULL DEFAULT 0,
      last_error       TEXT,
      result           JSONB,
      received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_attempt_at  TIMESTAMPTZ,
      applied_at       TIMESTAMPTZ,
      UNIQUE (provider, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_billing_event_receipts_open
      ON ochr_billing_event_receipts (status, received_at) WHERE status <> 'applied';
  `)
}
