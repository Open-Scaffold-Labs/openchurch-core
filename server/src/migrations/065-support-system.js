// 065 — Support system (SUP.1): the ticket queue behind "every church
// problem stops going directly to José."
//
// Two tables:
//
//   ochr_support_tickets    — in-app "Report a problem" rows, org-scoped.
//     The Aug 12 handoff's taxonomy is the schema, verbatim:
//       severity        critical | high | normal | low
//       status          new | diagnosing | waiting_on_parish | in_progress
//                       | resolved | closed
//       classification  bug | confusion | feature_request | product_insight
//     An async diagnostic pass (Claude) fills `diagnosis` with structured
//     triage — root cause, suspected files, proposed fix, and SUGGESTED
//     severity/classification. The suggestion is adopted onto the row only
//     while the ticket is untouched; a human's explicit setting always
//     wins afterward. Workflow state is human-owned, never AI-owned —
//     which is also why there is no 'failed' status: a diagnostic error is
//     recorded inside `diagnosis`, not allowed to move the ticket.
//   ochr_assistant_messages — one row per in-app assistant exchange: the
//     log that backs the per-org daily cap, the thumbs feedback loop, and
//     the cheapest product research there is (read what parishes actually
//     ask).
//
// Tenant privacy posture (the feedback-ledger FB.2 lesson applied):
// parish admins see ONLY their own org's tickets; the vendor (Open
// Scaffold Labs, env-identified — see middleware/superAdmin.js) sees all.
// Cross-org probes get 404, not 403, so ticket ids aren't enumerable.
// ochr_support_tickets deliberately keeps app-layer-only isolation
// because the vendor triage read is legitimately cross-org.
//
// Deliberately ABSENT: self-heal columns/endpoints. The Founder Decision
// Ledger (Aug 12) marks AI self-heal WAIT — when it's green-lit, a later
// migration adds the PR-tracking columns alongside the workflow.
//
// NOTE ON NUMBERING. The Support extension proposal numbered this 068,
// assuming the billing migrations (065–067) landed first. The founder
// decision reversed the order — support console ships first — so this is
// 065 and billing renumbers to 066–068 when approved.

import pool from '../db.js'

export async function up() {
  console.log('Migration 065: support-system — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_support_tickets (
      id                    BIGSERIAL PRIMARY KEY,
      organization_id       INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id               INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      description           TEXT NOT NULL,
      page_route            TEXT,
      context_bundle        JSONB,
      severity              TEXT NOT NULL DEFAULT 'normal'
                              CHECK (severity IN ('critical', 'high', 'normal', 'low')),
      status                TEXT NOT NULL DEFAULT 'new'
                              CHECK (status IN ('new', 'diagnosing', 'waiting_on_parish',
                                                'in_progress', 'resolved', 'closed')),
      classification        TEXT
                              CHECK (classification IS NULL OR classification IN
                                ('bug', 'confusion', 'feature_request', 'product_insight')),
      diagnosis             JSONB,
      diagnosis_tokens      JSONB,
      diagnosis_duration_ms INTEGER,
      assigned_to           TEXT,
      resolution_notes      TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // The parish admin's list view (org + status + recency) and the vendor
  // triage queue (open work across all orgs, worst first — the severity
  // ordering itself happens in SQL at read time; this index carries the
  // status + recency scan it starts from).
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_org
                    ON ochr_support_tickets(organization_id, status, created_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status
                    ON ochr_support_tickets(status, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_assistant_messages (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id          INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      page_route       TEXT,
      question         TEXT NOT NULL,
      answer           TEXT,
      provider         TEXT,
      model            TEXT,
      duration_ms      INTEGER,
      feedback         TEXT CHECK (feedback IS NULL OR feedback IN ('up', 'down')),
      feedback_note    TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // Daily-cap counting (org + day) and the feedback review view.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assistant_msgs_org_time
                    ON ochr_assistant_messages(organization_id, created_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assistant_msgs_feedback
                    ON ochr_assistant_messages(feedback, created_at DESC)
                    WHERE feedback IS NOT NULL`)

  // RLS enabled with no policy — the same blanket backstop every ochr_*
  // table carries; scoping is enforced in the route layer (see the
  // cross-org posture note in the header).
  await pool.query(`ALTER TABLE ochr_support_tickets    ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE ochr_assistant_messages ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 065: support-system — applied.')
}
