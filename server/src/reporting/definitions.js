// Report definitions (RPT.1).
//
// THE THESIS THIS IMPLEMENTS
//
//   PARISH WORK → OPENCHURCH RECORD → TRUSTED SOURCE DATA
//              → TRADITION-SPECIFIC REPORT → REVIEW → SUBMIT
//
// rather than the thing parishes actually do today, which is: do the work,
// enter it, re-enter it for the report, reconcile a spreadsheet, submit.
//
// A report is a DEFINITION — a list of fields, each with one query and one
// sentence about where its number comes from. Not a reporting engine, not a
// second database, not a per-report table. Adding a report is adding an
// object; the runner is thirty lines.
//
// EVERY FIELD DECLARES WHETHER WE HAVE VERIFIED THE REQUIREMENT
//
// This is the part that matters and the part that is easy to skip. We know
// what OUR data says. What we do NOT reliably know is what each report
// actually asks for — the 08-08 verification ledger has baptism counts and
// ASA as VERIFIED from a published source, and confirmations, marriages and
// burials as REQUIRES SOURCE CONFIRMATION. Nobody on this team has read the
// form.
//
// So `requirement` is a first-class field on every line:
//
//   'verified'    — a published source says this report asks for this.
//   'unverified'  — we believe it does. Nobody has read the form. The
//                   number is still computed and still correct about OUR
//                   records; what is unconfirmed is whether it belongs here.
//   'unsupported' — the report may ask for it and we cannot produce it.
//                   Say so, loudly, instead of emitting a zero that reads
//                   like an answer.
//
// A zero and a blank are different claims. "We baptised nobody this year"
// and "we cannot tell you how many people you received" must never render
// the same way on a sheet somebody signs.
//
// NOTHING HERE FILES ANYTHING. This produces a dataset for a human to check
// against a form. Until somebody has read the actual form — and asked a
// parish what they currently do — calling it a Parochial Report export
// would be exactly the kind of claim this codebase keeps having to retract.

// ── shared field builders ────────────────────────────────────────────────

// Register counts exclude voided entries (REG.1). A voided baptism is not a
// baptism that happened; including it would make the void meaningless and
// the report wrong in the same breath.
const sacramentCount = (type) => ({
  sql: `SELECT count(*)::int AS value
          FROM ochr_sacramental_records
         WHERE organization_id = $1
           AND type = '${type}'
           AND voided_at IS NULL
           AND date >= $2 AND date <= $3`,
  source: `Register entries of type "${type}" dated in the period, excluding voided entries.`,
})

// ── the Episcopal Parochial Report ───────────────────────────────────────

// A PERSON, NOT A ROW.
//
// Every attendance figure below counts check-in rows, and a row is not a
// person. The active-row uniqueness index (uq_checkins_active) stops a member
// being checked in twice AT ONCE — it says nothing about a member who was
// checked out and checked back in, which leaves two rows for one person at
// one service. count(*) reported that person twice; a service with three
// people read as eight. On the parochial report that is a compliance figure
// inflated by a workflow the volunteer was right to use.
//
// So attendance counts DISTINCT people AT A SERVICE: a linked member once
// per service, however many rows they generated there; a guest per row,
// because a guest carries no identity to collapse on (five taps for "Smith
// family" may be five people). PER SERVICE, deliberately: someone at both
// the 8am and the 10am is attendance at two services, which is what these
// figures sum — collapsing them across a date would be a report-policy
// change dressed as a bug fix. Every query using this must therefore group
// by the event before summing. Bound to the alias `ck`. Exported so the
// runner's Easter query and the attendance report use the same sentence —
// a second predicate typed inline is how two surfaces drift.
export const DISTINCT_PEOPLE = "count(DISTINCT COALESCE(ck.client_id::text, 'row:' || ck.id::text))"

const PAROCHIAL_REPORT = {
  key: 'parochial-report',
  traditions: ['episcopal', 'anglican'],
  title: 'Parochial Report — source data',
  subtitle: 'The figures OpenChurch holds, for checking against the form. Not a filing.',
  // The deadline is VERIFIED (generalconvention.org, "Deadline for
  // Congregations: March 1"). What the form asks for, line by line, is not.
  periodHint: 'calendar year',
  fields: [
    {
      key: 'baptisms', label: 'Baptisms', requirement: 'verified',
      ...sacramentCount('baptism'),
      note: 'Episcopal News Service, describing the official Register app, names baptism counts explicitly.',
    },
    {
      key: 'confirmations', label: 'Confirmations', requirement: 'unverified',
      ...sacramentCount('confirmation'),
      note: 'Widely assumed to be on the form. Nobody here has read it. Ask a parish before relying on this line.',
    },
    {
      key: 'receptions', label: 'Receptions', requirement: 'unsupported',
      sql: null,
      source: 'Not recorded. Reception into the Episcopal Church is not one of our register types.',
      note: 'A zero here would be a false statement, so no number is emitted. If parishes say this matters, it is a sacrament-type addition, not a query.',
    },
    {
      key: 'marriages', label: 'Marriages', requirement: 'unverified',
      ...sacramentCount('marriage'),
      note: 'Requires source confirmation — see the 08-08 verification ledger, item 4.',
    },
    {
      key: 'burials', label: 'Burials', requirement: 'unverified',
      ...sacramentCount('burial'),
      note: 'Burial joined the register in migration 070. Whether the form wants a count or the records is unconfirmed.',
    },
    {
      key: 'sunday_services', label: 'Sunday and principal services', requirement: 'unverified',
      sql: `SELECT count(*)::int AS value
              FROM ochr_calendar_events
             WHERE organization_id = $1 AND type = 'service'
               AND date >= $2 AND date <= $3
               AND EXTRACT(DOW FROM date) = 0`,
      source: 'Calendar entries of type "service" falling on a Sunday.',
      note: 'Counts what the parish scheduled. A service that was scheduled and not held will be counted; a service never entered will not.',
    },
    {
      key: 'weekday_services', label: 'Weekday services', requirement: 'unverified',
      sql: `SELECT count(*)::int AS value
              FROM ochr_calendar_events
             WHERE organization_id = $1 AND type = 'service'
               AND date >= $2 AND date <= $3
               AND EXTRACT(DOW FROM date) <> 0`,
      source: 'Calendar entries of type "service" not falling on a Sunday.',
    },
    {
      key: 'asa', label: 'Average Sunday attendance', requirement: 'verified',
      // Check-ins rather than roster marking, deliberately: ASA counts
      // people at worship, and a visitor is a person at worship. Roster
      // attendance only ever sees members.
      sql: `SELECT COALESCE(ROUND(AVG(n)::numeric, 1), 0)::float8 AS value
              FROM (
                SELECT date, SUM(n) AS n
                  FROM (
                    SELECT ck.attended_date AS date, ck.calendar_event_id AS id, ${DISTINCT_PEOPLE}::int AS n
                      FROM ochr_checkins ck
                     WHERE ck.organization_id = $1
                       AND ck.attended_date IS NOT NULL
                       AND ck.attended_date >= $2 AND ck.attended_date <= $3
                       AND EXTRACT(DOW FROM ck.attended_date) = 0
                     GROUP BY ck.attended_date, ck.calendar_event_id
                  ) per_service
                 GROUP BY date
              ) per_sunday`,
      source: 'Mean of the per-Sunday attendance, summing the distinct people at each service, including guests and children. A member checked out and back in at one service is one person there. Each Sunday is the service date stamped at check-in.',
      note: 'Only Sundays with at least one stamped check-in are averaged. A parish that does not use check-in will see 0 — which means "we have no data", not "nobody came". Older check-ins without a stamp are left out of this verified figure rather than dated from today\'s schedule.',
    },
    {
      key: 'easter_attendance', label: 'Easter attendance', requirement: 'unverified',
      sql: null,   // computed in the runner — Easter is a movable feast
      source: 'Attendance at Easter Day services, computed from the liturgical calendar — each service counts its distinct people.',
    },
    {
      key: 'christmas_attendance', label: 'Christmas attendance', requirement: 'unverified',
      sql: `SELECT COALESCE(SUM(n), 0)::int AS value
              FROM (
                SELECT ck.calendar_event_id AS id, ${DISTINCT_PEOPLE} AS n
                  FROM ochr_checkins ck
                 WHERE ck.organization_id = $1
                   AND ck.attended_date IS NOT NULL
                   AND ck.attended_date >= $2 AND ck.attended_date <= $3
                   AND EXTRACT(MONTH FROM ck.attended_date) = 12 AND EXTRACT(DAY FROM ck.attended_date) IN (24, 25)
                 GROUP BY ck.calendar_event_id
              ) per_service`,
      source: 'Attendance at services on 24 and 25 December as attended — each service counts its distinct people. Rows without a stamp are not dated from today\'s schedule.',
    },
    {
      key: 'active_members', label: 'Members on the rolls', requirement: 'unverified',
      sql: `SELECT count(*)::int AS value
              FROM ochr_clients
             WHERE organization_id = $1 AND COALESCE(status, 'active') = 'active'`,
      source: 'Members currently marked active. NOT period-scoped — this is a snapshot of today.',
      note: 'Membership reconciliation on the form is a year-over-year movement (added, removed, transferred). We hold a current count, not the movement. Treat this as a starting point a human reconciles, not an answer.',
    },
  ],
}

export const REPORTS = [PAROCHIAL_REPORT]

export function reportsForTradition(tradition) {
  return REPORTS.filter(r => r.traditions.includes(tradition))
}

export function findReport(key, tradition) {
  return REPORTS.find(r => r.key === key && r.traditions.includes(tradition)) ?? null
}
