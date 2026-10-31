/**
 * @openscaffold/schedule — PostgreSQL Schema & STD-15 Forced RLS Migrations (`osc_sched_*`)
 *
 * Unifies calendaring across all 12 OSL vertical families:
 *  - Uses PostgreSQL `btree_gist` and `EXCLUDE USING gist (resource_id WITH =, slot_range WITH &&)`
 *    so double-booking a chair, operatory, bay, court, table, room, crew, or provider is
 *    mathematically impossible at the database constraint layer.
 *  - Incorporates `OpenSalon`'s `hs_stylist_busy_ranges` split-time processing-gap model
 *    (`osc_sched_segments` + `osc_sched_busy_ranges`) alongside `OpenDentist` multi-resource
 *    hygienist/doctor overlaps and tokenized RFC 5545 `.ics` feeds (`osc_sched_ics_tokens`).
 */

// NOT MIGRATION-READY (TARS S398 review of 409159d): this SQL is an
// un-wired reference string. It is not in server/migrations and must not be
// applied until tenant isolation (organization_id scoping + RLS against
// OpenChurch's tenancy model) is reviewed.
const SCHEDULING_MIGRATION_SQL = `
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. Schedulable Resources (Chairs, Operatories, Tables, Tee Boxes, Bays, Courts, Rooms, Apparatus, Staff)
CREATE TABLE IF NOT EXISTS osc_sched_resources (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              TEXT NOT NULL,
  name                TEXT NOT NULL,
  resource_type       TEXT NOT NULL CHECK (resource_type IN (
    'provider', 'dental_operatory', 'salon_chair', 'chiro_room',
    'restaurant_table', 'golf_tee', 'simulator_bay', 'court',
    'clubhouse_amenity', 'church_room', 'crew', 'apparatus', 'banquet_space'
  )),
  capacity            INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  location_zone       TEXT,
  skills_or_ranks     TEXT[] DEFAULT '{}',
  metadata            JSONB DEFAULT '{}'::jsonb,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Bookings (Appointments, Tee Times, Table Reservations, Room Bookings, Crew Route Stops)
CREATE TABLE IF NOT EXISTS osc_sched_bookings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  TEXT NOT NULL,
  vertical_key            TEXT NOT NULL,
  calendar_mode           TEXT NOT NULL DEFAULT 'MODE_A_APPOINTMENT_CHAIR' CHECK (calendar_mode IN (
    'MODE_A_APPOINTMENT_CHAIR',
    'MODE_B_CREW_WEATHER_ROUTE',
    'MODE_C_EVENT_FACILITY_TEE',
    'MODE_D_SHIFT_ROSTER'
  )),
  booking_kind            TEXT NOT NULL CHECK (booking_kind IN (
    'appointment', 'tee_time', 'table_reservation', 'amenity_reservation', 'crew_dispatch', 'event_room'
  )),
  customer_account_id     UUID,
  customer_name           TEXT NOT NULL,
  party_size              INTEGER NOT NULL DEFAULT 1 CHECK (party_size >= 1),
  status                  TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN (
    'requested', 'confirmed', 'checked_in', 'seated_or_on_course', 'completed', 'no_show', 'canceled'
  )),
  starts_at               TIMESTAMPTZ NOT NULL,
  ends_at                 TIMESTAMPTZ NOT NULL,
  applied_minutes         INTEGER NOT NULL DEFAULT 0 CHECK (applied_minutes >= 0),
  processing_minutes      INTEGER NOT NULL DEFAULT 0 CHECK (processing_minutes >= 0),
  buffer_before_minutes   INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes    INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  allow_double_book_in_gap BOOLEAN NOT NULL DEFAULT false,
  recall_interval_days    INTEGER,
  deposit_payment_id      TEXT,
  no_show_fee_cents       BIGINT NOT NULL DEFAULT 0,
  notes                   TEXT,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_booking_window CHECK (ends_at > starts_at)
);

-- 3. Resource Allocations with GiST Overlap Exclusion Constraint
CREATE TABLE IF NOT EXISTS osc_sched_allocations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              TEXT NOT NULL,
  booking_id          UUID NOT NULL REFERENCES osc_sched_bookings(id) ON DELETE CASCADE,
  resource_id         UUID NOT NULL REFERENCES osc_sched_resources(id) ON DELETE CASCADE,
  segment_label       TEXT NOT NULL DEFAULT 'primary',
  slot_range          TSTZRANGE NOT NULL,
  slots_used          INTEGER NOT NULL DEFAULT 1 CHECK (slots_used >= 1),
  active_exclusive    BOOLEAN NOT NULL DEFAULT true,
  EXCLUDE USING gist (
    resource_id WITH =,
    slot_range WITH &&
  ) WHERE (active_exclusive = true)
);

-- 4. Explicit Split-Time & Multi-Phase Segments (Salon Processing Gaps, Dental Hygienist/Doctor Split, Landscape Phases)
CREATE TABLE IF NOT EXISTS osc_sched_segments (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    TEXT NOT NULL,
  booking_id                UUID NOT NULL REFERENCES osc_sched_bookings(id) ON DELETE CASCADE,
  resource_id               UUID NOT NULL REFERENCES osc_sched_resources(id) ON DELETE CASCADE,
  segment_phase             TEXT NOT NULL CHECK (segment_phase IN (
    'buffer_setup', 'application', 'processing_gap', 'finishing', 'buffer_cleanup',
    'hygienist_prep', 'doctor_exam', 'site_visit', 'material_delivery', 'crew_install'
  )),
  starts_at                 TIMESTAMPTZ NOT NULL,
  ends_at                   TIMESTAMPTZ NOT NULL,
  slot_range                TSTZRANGE GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  allow_double_book_in_gap  BOOLEAN NOT NULL DEFAULT false,
  occupies_provider         BOOLEAN NOT NULL DEFAULT true,
  EXCLUDE USING gist (
    resource_id WITH =,
    slot_range WITH &&
  ) WHERE (occupies_provider = true AND allow_double_book_in_gap = false)
);

-- SQL helper harvested from OpenSalon 004_hs_split_time.sql: returns 1 contiguous range
-- or 2 busy ranges when a processing gap splits the appointment.
CREATE OR REPLACE FUNCTION osc_sched_busy_ranges(
  _starts_at timestamptz, _ends_at timestamptz,
  _applied int, _processing int, _buf_before int, _buf_after int
) RETURNS tstzrange[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN _processing > 0 THEN
    ARRAY[
      tstzrange(_starts_at - make_interval(mins => _buf_before),
                _starts_at + make_interval(mins => _applied), '[)'),
      tstzrange(_starts_at + make_interval(mins => _applied + _processing),
                _ends_at + make_interval(mins => _buf_after), '[)')
    ]
  ELSE
    ARRAY[
      tstzrange(_starts_at - make_interval(mins => _buf_before),
                _ends_at + make_interval(mins => _buf_after), '[)')
    ]
  END
$$;

-- 5. Staff & Apparatus Shift Rotations (including 24/48 & 48/96 Firehouse Kelly Shifts & Salon Booth Rosters)
CREATE TABLE IF NOT EXISTS osc_sched_shifts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              TEXT NOT NULL,
  resource_id         UUID NOT NULL REFERENCES osc_sched_resources(id) ON DELETE CASCADE,
  platoon_or_team     TEXT,
  role_rank           TEXT,
  shift_range         TSTZRANGE NOT NULL,
  shift_kind          TEXT NOT NULL DEFAULT 'regular' CHECK (shift_kind IN ('regular', 'kelly_24_48', 'kelly_48_96', 'on_call', 'overtime', 'swap', 'booth_rental')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Priority Waitlist & Instant Slot Offer Claims
CREATE TABLE IF NOT EXISTS osc_sched_waitlist (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              TEXT NOT NULL,
  vertical_key        TEXT NOT NULL,
  customer_name       TEXT NOT NULL,
  customer_phone      TEXT,
  party_size          INTEGER NOT NULL DEFAULT 1,
  desired_date        DATE NOT NULL,
  preferred_window    TSTZRANGE,
  priority_score      INTEGER NOT NULL DEFAULT 100,
  status              TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'claimed', 'expired', 'canceled')),
  offer_expires_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Tokenized Tenant-Scoped RFC 5545 .ics Feed Subscriptions & Two-Way Webhook Sync
CREATE TABLE IF NOT EXISTS osc_sched_ics_tokens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              TEXT NOT NULL,
  resource_id         UUID REFERENCES osc_sched_resources(id) ON DELETE CASCADE,
  token_sha256        TEXT NOT NULL UNIQUE,
  feed_scope          TEXT NOT NULL DEFAULT 'resource' CHECK (feed_scope IN ('org_all', 'resource', 'customer')),
  external_provider   TEXT CHECK (external_provider IN ('google_calendar', 'apple_caldav', 'microsoft_outlook', 'ics_poll')),
  webhook_sync_cursor TEXT,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- STD-15 Forced Row-Level Security across all osc_sched_* tables
ALTER TABLE osc_sched_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_bookings FORCE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_segments FORCE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_shifts FORCE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_waitlist FORCE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_ics_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE osc_sched_ics_tokens FORCE ROW LEVEL SECURITY;
`;

async function ensureSchedulingSchema(pool) {
  await pool.query(SCHEDULING_MIGRATION_SQL);
  return {
    initialized: true,
    tables: [
      'osc_sched_resources',
      'osc_sched_bookings',
      'osc_sched_allocations',
      'osc_sched_segments',
      'osc_sched_shifts',
      'osc_sched_waitlist',
      'osc_sched_ics_tokens',
    ],
  };
}

module.exports = {
  SCHEDULING_MIGRATION_SQL,
  ensureSchedulingSchema,
  SCHEDULE_MIGRATION_SQL: SCHEDULING_MIGRATION_SQL,
  ensureScheduleSchema: ensureSchedulingSchema,
};
