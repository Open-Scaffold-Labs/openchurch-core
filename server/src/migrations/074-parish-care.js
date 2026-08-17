// 074 — Parish Care: the diocesan office's memory of a parish.
//
// WHAT THIS IS FOR
//
// The question the diocese actually has is not "which parish is failing".
// It is "what parish needs care, what is the context, and what is the next
// faithful action". Those are different questions and they need different
// tables.
//
// So: nothing here scores a parish. Nothing here stores a verdict. Every
// row is either a thing a human wrote down or a thing a human agreed to,
// and status is computed from those at read time — an invitation to
// judgement, never a conclusion filed on a parish's permanent record.
//
// WHAT DELIBERATELY DOES NOT EXIST IN THIS SCHEMA
//
//   · No risk score, health score, engagement metric, or ranking column —
//     not even a hidden one. There is no proxy for human judgement here,
//     because a number a diocese cannot explain out loud is a number that
//     will eventually be used to explain something.
//   · No 'at_risk', 'delinquent', 'overdue' or 'non_compliant' state.
//   · No stored status at all. See careStatus.js: it is derived, and its
//     derivation names its own reason in the same breath.
//
// WHAT IT ADDS
//
//   ochr_diocese_regions      — deaneries / regions, for orientation
//   ochr_parish_followups     — the diocesan office's private memory aid
//   ochr_parish_transitions   — continuity when people change
//   ochr_parish_timeline      — the institutional record, human-readable
//   ochr_report_review_notes  — shared review, with explicit visibility
//   ochr_parish_care_briefs   — a record that a brief was prepared, by whom
//
// ON THE TIMELINE
//
// It reads like an institutional record, not an activity feed. Entries are
// written in sentences a person could read aloud at a meeting, they carry
// the actor as a SNAPSHOT (same reasoning as register amendments in 073 —
// a canon who moves on does not take the authorship of a visit with them),
// and they are never pruned. A diocese's memory of a parish outlives the
// staff on both sides of it.

import pool from '../db.js'

export async function up() {
  // ── Regions / deaneries ──────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_diocese_regions (
      id              BIGSERIAL PRIMARY KEY,
      diocese_org_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (diocese_org_id, name)
    )
  `)
  // A parish belongs to a region through its affiliation, because the
  // relationship is the diocese's, not the parish's. A parish that leaves
  // one diocese for another does not carry a deanery with it.
  await pool.query(`
    ALTER TABLE ochr_diocese_affiliations
      ADD COLUMN IF NOT EXISTS region_id BIGINT REFERENCES ochr_diocese_regions(id) ON DELETE SET NULL
  `)

  // ── Follow-ups — a memory aid, NOT a task system for parishes ────────
  //
  // Owned by the diocesan office and never visible to a parish. "Prepare
  // check-in" rather than "follow up overdue"; there is no overdue state
  // and no notification, because a diocese chasing its own reminder is not
  // the same thing as a parish being chased.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_parish_followups (
      id              BIGSERIAL PRIMARY KEY,
      diocese_org_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      parish_org_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      context         TEXT NOT NULL CHECK (length(btrim(context)) >= 3),
      next_action     TEXT NOT NULL CHECK (length(btrim(next_action)) >= 3),
      owner_user_id   INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      owner_name      TEXT,
      due_on          DATE,
      state           TEXT NOT NULL DEFAULT 'open'
                        CHECK (state IN ('open', 'done', 'let_go')),
      completion_note TEXT,
      created_by      INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      created_by_name TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // 'let_go' rather than 'cancelled' or 'dropped'. Deciding a follow-up is
  // no longer needed is a legitimate pastoral judgement and should not read
  // like a failure to complete a ticket.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_followups_open
      ON ochr_parish_followups(diocese_org_id, parish_org_id) WHERE state = 'open'
  `)

  // ── Transitions — continuity, not intelligence gathering ─────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_parish_transitions (
      id               BIGSERIAL PRIMARY KEY,
      diocese_org_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      parish_org_id    INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      kind             TEXT NOT NULL CHECK (kind IN (
                         'clergy_arrival', 'clergy_departure', 'administrator_departure',
                         'music_staff', 'search_period', 'records_handoff', 'onboarding_support')),
      began_on         DATE,
      expected_until   DATE,
      notes            TEXT,
      continuity_needs TEXT,
      support_plan     TEXT,
      owner_user_id    INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      owner_name       TEXT,
      state            TEXT NOT NULL DEFAULT 'watching'
                         CHECK (state IN ('watching', 'settled')),
      created_by       INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // ── The institutional record ─────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_parish_timeline (
      id              BIGSERIAL PRIMARY KEY,
      diocese_org_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      parish_org_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL CHECK (kind IN (
                        'report', 'visit', 'support_request', 'transition',
                        'followup', 'brief', 'note')),
      -- A sentence a person could read aloud at a meeting.
      summary         TEXT NOT NULL CHECK (length(btrim(summary)) >= 3),
      detail          TEXT,
      occurred_on     DATE NOT NULL DEFAULT CURRENT_DATE,
      -- Diocese-only entries never reach a parish or a printed brief
      -- unless the preparer's role allows it. Default is the safer one.
      visibility      TEXT NOT NULL DEFAULT 'diocese'
                        CHECK (visibility IN ('diocese', 'shared')),
      actor_user_id   INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      actor_name      TEXT,
      actor_email     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_timeline_parish
      ON ochr_parish_timeline(diocese_org_id, parish_org_id, occurred_on DESC, id DESC)
  `)

  // ── Shared review of a report ────────────────────────────────────────
  //
  // The stored submission states stay as they are — 'approved' gates the
  // assessment roll-up and renaming it would be a money change dressed as
  // a vocabulary change. What was missing is the conversation: notes, with
  // an explicit choice about who can see them, and an agreed next step.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_report_review_notes (
      id              BIGSERIAL PRIMARY KEY,
      diocese_org_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      submission_id   BIGINT NOT NULL REFERENCES ochr_report_submissions(id) ON DELETE CASCADE,
      body            TEXT NOT NULL CHECK (length(btrim(body)) >= 1),
      visibility      TEXT NOT NULL DEFAULT 'diocese'
                        CHECK (visibility IN ('diocese', 'shared')),
      agreed_next_step TEXT,
      follow_up_on    DATE,
      author_user_id  INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      author_name     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_review_notes_submission
      ON ochr_report_review_notes(submission_id, created_at)
  `)

  // ── A record that a brief was prepared ───────────────────────────────
  //
  // Not the brief's content — that is regenerated from live context, and a
  // stale brief masquerading as current is worse than no brief. What is
  // recorded is that somebody prepared one, when, and for what, so the
  // timeline can say "a care brief was prepared before the bishop's visit".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_parish_care_briefs (
      id              BIGSERIAL PRIMARY KEY,
      diocese_org_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      parish_org_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      purpose         TEXT,
      prepared_by     INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      prepared_by_name TEXT,
      prepared_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // ── Tenant FKs, per 071 and the CI gate ──────────────────────────────
  //
  // Every one of these tables is keyed on the DIOCESE's org id, so the
  // composite pairs point at ochr_users(id, organization_id) with
  // column-scoped SET NULL — a staff member leaving nulls the pointer, the
  // name snapshot keeps the row readable, and organization_id survives.
  const actorCols = [
    ['ochr_parish_followups',    'owner_user_id',  'followups_owner'],
    ['ochr_parish_followups',    'created_by',     'followups_creator'],
    ['ochr_parish_transitions',  'owner_user_id',  'transitions_owner'],
    ['ochr_parish_transitions',  'created_by',     'transitions_creator'],
    ['ochr_parish_timeline',     'actor_user_id',  'timeline_actor'],
    ['ochr_report_review_notes', 'author_user_id', 'review_notes_author'],
    ['ochr_parish_care_briefs',  'prepared_by',    'care_briefs_preparer'],
  ]
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_users_id_org_uniq') THEN
        ALTER TABLE ochr_users ADD CONSTRAINT ochr_users_id_org_uniq UNIQUE (id, organization_id);
      END IF;
    END $$;
  `)
  for (const [table, col, tag] of actorCols) {
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_${col}_fkey') THEN
          ALTER TABLE ${table} DROP CONSTRAINT ${table}_${col}_fkey;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_${tag}_fk') THEN
          ALTER TABLE ${table}
            ADD CONSTRAINT ochr_${tag}_fk
            FOREIGN KEY (${col}, diocese_org_id)
            REFERENCES ochr_users(id, organization_id) ON DELETE SET NULL (${col});
        END IF;
      END $$;
    `)
  }

  // Three more the gate found once it could see diocese-keyed tables.
  // Two are this migration's own; the third has been open since 058.
  await pool.query(`
    DO $$
    BEGIN
      -- A region belongs to the same diocese as the affiliation using it.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_diocese_regions_id_dio_uniq') THEN
        ALTER TABLE ochr_diocese_regions ADD CONSTRAINT ochr_diocese_regions_id_dio_uniq UNIQUE (id, diocese_org_id);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_diocese_affiliations_region_id_fkey') THEN
        ALTER TABLE ochr_diocese_affiliations DROP CONSTRAINT ochr_diocese_affiliations_region_id_fkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_affiliation_region_fk') THEN
        ALTER TABLE ochr_diocese_affiliations
          ADD CONSTRAINT ochr_affiliation_region_fk
          FOREIGN KEY (region_id, diocese_org_id)
          REFERENCES ochr_diocese_regions(id, diocese_org_id) ON DELETE SET NULL (region_id);
      END IF;

      -- A review note belongs to the same diocese as the submission it is about.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_report_submissions_id_dio_uniq') THEN
        ALTER TABLE ochr_report_submissions ADD CONSTRAINT ochr_report_submissions_id_dio_uniq UNIQUE (id, diocese_org_id);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_report_review_notes_submission_id_fkey') THEN
        ALTER TABLE ochr_report_review_notes DROP CONSTRAINT ochr_report_review_notes_submission_id_fkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_review_note_submission_fk') THEN
        ALTER TABLE ochr_report_review_notes
          ADD CONSTRAINT ochr_review_note_submission_fk
          FOREIGN KEY (submission_id, diocese_org_id)
          REFERENCES ochr_report_submissions(id, diocese_org_id) ON DELETE CASCADE;
      END IF;

      -- OPEN SINCE 058, and only visible once the gate learned to read
      -- diocese-keyed tables: accepted_by is the PARISH admin who accepted
      -- the invitation, so it pairs with parish_org_id, NOT diocese_org_id.
      -- Pairing it with the diocese would have been the natural-looking
      -- fix and would have been wrong — it would require the accepting
      -- user to be a diocesan employee.
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_diocese_affiliations_accepted_by_fkey') THEN
        ALTER TABLE ochr_diocese_affiliations DROP CONSTRAINT ochr_diocese_affiliations_accepted_by_fkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_affiliation_accepted_by_fk') THEN
        ALTER TABLE ochr_diocese_affiliations
          ADD CONSTRAINT ochr_affiliation_accepted_by_fk
          FOREIGN KEY (accepted_by, parish_org_id)
          REFERENCES ochr_users(id, organization_id) ON DELETE SET NULL (accepted_by);
      END IF;
    END $$;
  `)

  for (const t of ['ochr_diocese_regions', 'ochr_parish_followups', 'ochr_parish_transitions',
                   'ochr_parish_timeline', 'ochr_report_review_notes', 'ochr_parish_care_briefs']) {
    await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`)
  }

  console.log('Migration 074: parish care — applied.')
}
