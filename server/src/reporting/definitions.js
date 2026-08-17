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
                SELECT e.date, count(*)::int AS n
                  FROM ochr_checkins ck
                  JOIN ochr_calendar_events e ON e.id = ck.calendar_event_id
                 WHERE ck.organization_id = $1
                   AND e.date >= $2 AND e.date <= $3
                   AND EXTRACT(DOW FROM e.date) = 0
                 GROUP BY e.date
              ) per_sunday`,
      source: 'Mean of the per-Sunday check-in count, including guests and children.',
      note: 'Only Sundays with at least one check-in are averaged. A parish that does not use check-in will see 0 — which means "we have no data", not "nobody came".',
    },
    {
      key: 'easter_attendance', label: 'Easter attendance', requirement: 'unverified',
      sql: null,   // computed in the runner — Easter is a movable feast
      source: 'Check-ins on Easter Day, computed from the liturgical calendar.',
    },
    {
      key: 'christmas_attendance', label: 'Christmas attendance', requirement: 'unverified',
      sql: `SELECT COALESCE(count(*), 0)::int AS value
              FROM ochr_checkins ck
              JOIN ochr_calendar_events e ON e.id = ck.calendar_event_id
             WHERE ck.organization_id = $1
               AND e.date >= $2 AND e.date <= $3
               AND EXTRACT(MONTH FROM e.date) = 12 AND EXTRACT(DAY FROM e.date) IN (24, 25)`,
      source: 'Check-ins on 24 and 25 December.',
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
