// Seeds a substantial set of sample rows into a new organization so
// the demo isn't a wall of zeros AND so the features shipped over the
// last several sprints are visible immediately on first login.
//
// Every seeded row is identifiable by a "[Sample]" marker — name,
// title, notes — so the whole set can be wiped via
// POST /api/onboarding/clear-samples.
//
// Intentionally denomination-neutral: "Sunday Service" rather than
// "Mass," generic categories, widely-applicable roles. The point is
// to show the shape and flow of the product, not preload the admin's
// real data.
//
// Called *after* the signup transaction commits — a seed failure
// should never block account creation. See server/src/routes/auth.js.

// ── Members ──────────────────────────────────────────────────
//
// Mix of ages, roles, tenure. Birth dates are seeded so birthday
// reminders demo immediately on fresh signup; two are within the
// next 7 days. Joined dates span 6 months to 10 years so the demo
// shows what a long-tenure roster looks like.
//
// Birthdays computed relative to "today" so the demo always has
// upcoming birthdays regardless of when the signup happens.

function daysFromNow(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// Returns YYYY-MM-DD for a date with month/day from `mdRef` (e.g. a
// "next-week" Date from daysFromNow) but year set N years ago.
function birthYearOffsetFrom(mdRef, yearsAgo) {
  const d = new Date(mdRef + 'T00:00:00Z')
  d.setUTCFullYear(d.getUTCFullYear() - yearsAgo)
  return d.toISOString().slice(0, 10)
}

function buildSampleMembers() {
  const upcoming1 = daysFromNow(2)   // birthday in 2 days — demos birthday job
  const upcoming2 = daysFromNow(5)   // birthday in 5 days
  return [
    {
      name: '[Sample] Maria Garcia', email: 'maria.sample@example.com',
      phone: '(555) 010-2031', role: 'Choir Member', tags: 'music,volunteer',
      birth_date: birthYearOffsetFrom(upcoming1, 47),
      joined_date: '2018-09-15',
    },
    {
      name: '[Sample] John Rivera', email: 'john.sample@example.com',
      phone: '(555) 010-2032', role: 'Usher', tags: 'sunday-service,greeter',
      birth_date: '1972-04-12',
      joined_date: '2014-03-22',
    },
    {
      name: '[Sample] Sarah Chen', email: 'sarah.sample@example.com',
      phone: '(555) 010-2033', role: 'Finance Committee', tags: 'leadership,volunteer',
      birth_date: '1985-11-03',
      joined_date: '2019-01-08',
    },
    {
      name: '[Sample] David Okafor', email: 'david.sample@example.com',
      phone: '(555) 010-2034', role: 'Youth Leader', tags: 'youth,leadership',
      birth_date: birthYearOffsetFrom(upcoming2, 35),
      joined_date: '2021-08-30',
    },
    {
      name: '[Sample] Priya Patel', email: 'priya.sample@example.com',
      phone: '(555) 010-2035', role: 'Sunday School Teacher', tags: 'children,formation',
      birth_date: '1990-02-19',
      joined_date: '2017-05-14',
    },
    {
      name: '[Sample] Michael O’Connor', email: 'michael.sample@example.com',
      phone: '(555) 010-2036', role: 'Deacon', tags: 'leadership,sunday-service',
      birth_date: '1965-06-27',
      joined_date: '2008-10-05',
    },
    {
      name: '[Sample] Aaliyah Jackson', email: 'aaliyah.sample@example.com',
      phone: '(555) 010-2037', role: 'Worship Leader', tags: 'music,leadership',
      birth_date: '1992-09-14',
      joined_date: '2020-02-23',
    },
    {
      name: '[Sample] Tomas Nguyen', email: 'tomas.sample@example.com',
      phone: '(555) 010-2038', role: 'Hospitality', tags: 'volunteer,greeter',
      birth_date: '1978-12-08',
      joined_date: '2015-11-10',
    },
    {
      name: '[Sample] Rachel Goldberg', email: 'rachel.sample@example.com',
      phone: '(555) 010-2039', role: 'Member', tags: 'newcomer',
      birth_date: '1995-07-22',
      joined_date: daysFromNow(-90),                // joined recently
    },
    {
      name: '[Sample] Daniel Martinez', email: 'daniel.sample@example.com',
      phone: '(555) 010-2040', role: 'Tech / AV', tags: 'sunday-service,volunteer',
      birth_date: '1988-03-15',
      joined_date: '2016-04-19',
    },
    {
      name: '[Sample] Eleanor Smith', email: 'eleanor.sample@example.com',
      phone: '(555) 010-2041', role: 'Prayer Team', tags: 'volunteer',
      birth_date: '1948-08-04',
      joined_date: '2002-09-08',                    // long-tenure
    },
    {
      name: '[Sample] Hassan Ahmed', email: 'hassan.sample@example.com',
      phone: '(555) 010-2042', role: 'Member', tags: 'newcomer',
      birth_date: '2001-10-30',
      joined_date: daysFromNow(-30),                // very new
    },
  ]
}

// ── Tasks ────────────────────────────────────────────────────

const SAMPLE_TASKS = [
  { slug: 'bulletins',  title: '[Sample] Prepare Sunday bulletins',       category: 'SERVICE_PREP', priority: 'MEDIUM', description: 'Print the week’s bulletins and fold them before Saturday night.' },
  { slug: 'cleaning',   title: '[Sample] Clean sanctuary before service', category: 'CLEANING',     priority: 'HIGH',   description: 'Vacuum, wipe pews, restock tissue boxes at entrances.' },
  { slug: 'av-check',   title: '[Sample] Check projector + sound system', category: 'MAINTENANCE',  priority: 'LOW',    description: 'Verify mics, projector, and live-stream feed an hour before service.' },
  { slug: 'snacks',     title: '[Sample] Pick up coffee + snacks',        category: 'SERVICE_PREP', priority: 'MEDIUM', description: 'Coffee, tea, light snacks for hospitality table after service.' },
  { slug: 'newsletter', title: '[Sample] Send weekly newsletter',         category: 'COMMUNICATIONS', priority: 'HIGH', description: 'Compose, schedule, and send the weekly email to all members.' },
]

// ── Events (ochr_events) ─────────────────────────────────────
//
// One-off events surfaced on the Events page. The recurring entries
// live on ochr_calendar_events (Schedule page) below — different table.

function nextDowStr(dow) {
  const now = new Date()
  const today = now.getDay()
  let offset = (dow - today + 7) % 7
  if (offset === 0) offset = 7
  const d = new Date(now)
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 10)
}

function buildSampleEvents() {
  return [
    { title: '[Sample] Sunday Service',        service_division: 'Worship',   date: nextDowStr(0),     time: '10:00', location: 'Main Sanctuary' },
    { title: '[Sample] Wednesday Bible Study', service_division: 'Formation', date: nextDowStr(3),     time: '19:00', location: 'Fellowship Hall' },
    { title: '[Sample] Parish Potluck',        service_division: 'Community', date: nextDowStr(6),     time: '17:30', location: 'Parish Hall' },
    { title: '[Sample] Volunteer Training',    service_division: 'Formation', date: daysFromNow(14),   time: '14:00', location: 'Fellowship Hall' },
  ]
}

// ── Schedule entries (ochr_calendar_events) ──────────────────
//
// The Schedule page reads from ochr_calendar_events. We seed a
// recurring Sunday service for 8 weeks via parent_id so the demo
// shows the recurrence + assignment + calendar-sync features all at
// once. 2-3 of the seeded members get assigned so each of their
// personal calendar feeds returns content.

function buildRecurringSundayDates(weekCount = 8) {
  const seed = nextDowStr(0)
  const dates = []
  for (let i = 0; i < weekCount; i++) {
    const d = new Date(seed + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + i * 7)
    dates.push(d.toISOString().slice(0, 10))
  }
  return dates
}

// ── Donations ────────────────────────────────────────────────
//
// 8 entries spread across the last 30 days. Notes carry the
// [Sample] marker so the cleanup query can match on it without
// putting "[Sample]" in front of every donor name.

// Donor email + address are populated for the named-check donors so
// the year-end giving statements feature (Sprint Y) has demo data on
// fresh signups. Cash-only walk-in style donors stay anonymous (no
// email/address) so the preview list shows both branches —
// 'grouped-by-email' and 'grouped-by-name' donors side by side.
function buildSampleDonations() {
  return [
    { donor_name: 'Maria Garcia',    amount: 150,  category: 'tithe',           method: 'cash',  daysAgo: 2,  notes: '[Sample] Sunday offering' },
    { donor_name: 'John Rivera',     amount: 75,   category: 'tithe',           method: 'cash',  daysAgo: 2,  notes: '[Sample] Sunday offering' },
    { donor_name: 'Sarah Chen',      amount: 500,  category: 'tithe',           method: 'check', daysAgo: 9,  notes: '[Sample] Monthly tithe',
      donor_email: 'sarah.chen@example.org', donor_address: '142 Olive St, Austin TX 78701' },
    { donor_name: 'David Okafor',    amount: 50,   category: 'special offering', method: 'cash', daysAgo: 9,  notes: '[Sample] Building fund' },
    { donor_name: 'Priya Patel',     amount: 200,  category: 'tithe',           method: 'check', daysAgo: 16, notes: '[Sample] Bi-weekly',
      donor_email: 'priya.patel@example.org', donor_address: '88 Riverbend Dr, Austin TX 78703' },
    { donor_name: 'Michael O’Connor', amount: 1000, category: 'special offering', method: 'check', daysAgo: 16, notes: '[Sample] Year-end gift',
      donor_email: 'michael.oconnor@example.org', donor_address: '4 Cedarbrook Ln, Austin TX 78759' },
    { donor_name: 'Aaliyah Jackson', amount: 60,   category: 'tithe',           method: 'cash',  daysAgo: 23, notes: '[Sample] Sunday offering' },
    { donor_name: 'Tomas Nguyen',    amount: 125,  category: 'tithe',           method: 'check', daysAgo: 30, notes: '[Sample] Monthly',
      donor_email: 'tomas.nguyen@example.org', donor_address: '21 Maple Ct, Austin TX 78704' },
    // A second gift from Sarah Chen so the per-donor breakdown
    // shows multiple line items for at least one donor.
    { donor_name: 'Sarah Chen',      amount: 250,  category: 'tithe',           method: 'check', daysAgo: 40, notes: '[Sample] Monthly tithe',
      donor_email: 'sarah.chen@example.org', donor_address: '142 Olive St, Austin TX 78701' },
  ]
}

// ── Payroll staff ────────────────────────────────────────────

const SAMPLE_STAFF = [
  { name: '[Sample] Pastor James Wright', role: 'Pastor',          pay_rate: 0,    status: 'active' },
  { name: '[Sample] Linda Park',          role: 'Office Manager',  pay_rate: 22.5, status: 'active' },
]

// ─────────────────────────────────────────────────────────────
// Seeds sample members, events, schedule entries, donations,
// payroll staff, and tasks into the given organization.
//
// `db` is anything with a .query method (pool or transaction client).
// Returns a summary count object. Any single subsection failure
// throws so the caller (auth signup) can log it without the rest of
// the request noticing.
//
// Seeds AT MOST ONCE PER ORG, ever. The marker is
// ochr_organizations.samples_seeded_at (migration 060), claimed
// atomically below.
//
// This used to guard on "does the org currently have any [Sample]
// tasks?" — which answers the wrong question. POST /api/onboarding/
// clear-samples deletes those rows, so after an admin cleared their
// sample data the guard read "unseeded" and the next run of
// runAllMigrations() (i.e. every production deploy, via CI's
// migrate-cli.js) re-inserted the whole sample set. Deleting only the
// sample *tasks* was worse: the rest of the sample rows survived, the
// guard still read "unseeded", and each deploy appended another full
// copy of the members, donations and schedule.
//
// The UPDATE ... WHERE samples_seeded_at IS NULL RETURNING id below is
// a single atomic claim: exactly one caller can win it, so concurrent
// boots or a retried signup request can't double-seed either. The
// marker is set BEFORE the rows are written — a seed that crashes
// half-way leaves the org marked, which is the safe direction to fail
// (a partial sample set is cosmetic; a resurrected one is data loss).
export async function seedSampleData(db, organizationId) {
  const { rows: claimed } = await db.query(
    `UPDATE ochr_organizations
        SET samples_seeded_at = NOW()
      WHERE id = $1 AND samples_seeded_at IS NULL
      RETURNING id`,
    [organizationId]
  )
  if (!claimed.length) return { skipped: true }

  // Members — keep insertion order so we can grab the first three
  // ids for the assignment list below.
  const memberIds = []
  for (const m of buildSampleMembers()) {
    const { rows } = await db.query(
      `INSERT INTO ochr_clients (organization_id, name, email, phone, role, tags, birth_date, joined_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [organizationId, m.name, m.email, m.phone, m.role, m.tags, m.birth_date, m.joined_date]
    )
    memberIds.push(rows[0].id)
  }

  // Events page entries (ochr_events) + roster assignments on the
  // Sunday service so the personal calendar feed has content for
  // those members.
  const events = buildSampleEvents()
  for (const e of events) {
    const { rows } = await db.query(
      `INSERT INTO ochr_events (organization_id, title, service_division, date, time, location)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, title`,
      [organizationId, e.title, e.service_division, e.date, e.time, e.location]
    )
    // Assign the first three members to the Sunday Service so the
    // personal calendar feed demo lands content immediately.
    if (rows[0].title.endsWith('Sunday Service')) {
      const eventId = rows[0].id
      for (const mid of memberIds.slice(0, 3)) {
        await db.query(
          `INSERT INTO ochr_event_members (event_id, organization_id, member_id) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [eventId, organizationId, mid]
        )
      }
    }
  }

  // Schedule page entries (ochr_calendar_events) — 8-week recurring
  // Sunday service. Seed first, stamp self-parent_id, then generate
  // the seven children with the seed's id as parent.
  const sundays = buildRecurringSundayDates(8)
  const seedAssignees = JSON.stringify(memberIds.slice(0, 3))
  const { rows: seedRow } = await db.query(
    `INSERT INTO ochr_calendar_events
       (organization_id, title, date, start_time, end_time, type, assigned_to)
     VALUES ($1, '[Sample] Sunday Service', $2, '10:00', '11:00', 'service', $3::jsonb)
     RETURNING id`,
    [organizationId, sundays[0], seedAssignees]
  )
  const seedId = seedRow[0].id
  await db.query(
    'UPDATE ochr_calendar_events SET recurrence_parent_id = $1 WHERE id = $1',
    [seedId]
  )
  for (let i = 1; i < sundays.length; i++) {
    await db.query(
      `INSERT INTO ochr_calendar_events
         (organization_id, title, date, start_time, end_time, type, assigned_to, recurrence_parent_id)
       VALUES ($1, '[Sample] Sunday Service', $2, '10:00', '11:00', 'service', $3::jsonb, $4)`,
      [organizationId, sundays[i], seedAssignees, seedId]
    )
  }

  // Donations spread across the last 40 days. donor_email +
  // donor_address are optional — populated for named-check donors so
  // the year-end statement aggregation has data to group by email.
  for (const d of buildSampleDonations()) {
    await db.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, donor_email, donor_address, amount, category, method, date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - ($8 || ' days')::interval, $9)`,
      [organizationId, d.donor_name, d.donor_email ?? null, d.donor_address ?? null,
       d.amount, d.category, d.method, String(d.daysAgo), d.notes]
    )
  }

  // Payroll staff. No shifts seeded — admin can log shifts to demo
  // the flow themselves.
  for (const s of SAMPLE_STAFF) {
    await db.query(
      `INSERT INTO ochr_payroll_staff (organization_id, name, role, pay_rate, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [organizationId, s.name, s.role, s.pay_rate, s.status]
    )
  }

  // Tasks last — the existence check at the top keys off this table,
  // so seeding it concludes the idempotency contract.
  for (const t of SAMPLE_TASKS) {
    const id = `sample-${organizationId}-${t.slug}`
    await db.query(
      `INSERT INTO ochr_tasks (organization_id, id, title, description, category, priority, status, checklist)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', '[]')`,
      [organizationId, id, t.title, t.description, t.category, t.priority]
    )
  }

  return {
    members:           memberIds.length,
    events:            events.length,
    schedule_entries:  sundays.length,
    donations:         buildSampleDonations().length,
    staff:             SAMPLE_STAFF.length,
    tasks:             SAMPLE_TASKS.length,
  }
}
