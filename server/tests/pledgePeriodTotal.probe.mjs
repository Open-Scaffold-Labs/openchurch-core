// One process, one TZ. Ledger's two instants, plus the standing DATE
// fields that used to shift east of UTC. Spawned by pledgePeriodTotal.test.js.

import pool from '../src/db.js'
import { attachFulfillment, expectedPeriodTotal } from '../src/routes/pledges.js'
import { eventAssignmentWhen } from '../src/routes/events.js'
import { daysSinceCivilDay } from '../src/utils/civilDay.js'
import { standingFor } from '../src/affiliation/standing.js'
import { migrateOnce, bindServer, closeServer } from './support/harness.js'
import { createOrg, provisioningOperatorOrgId } from './support/provision.js'

const fails = []
const tz = process.env.TZ || 'UTC'

function check(name, got, expected) {
  if (got !== expected) fails.push({ name, got: got ?? null, expected })
}

// 2026-09-27T04:17:00Z is 21:17 the previous evening in Los Angeles
// (civil date 2026-09-26) and 17:17 on 2026-09-27 in Auckland (NZDT).
// 2026-09-26T21:00:00Z is 10:00 on 2026-09-27 in Auckland and 14:00 on
// 2026-09-26 in Los Angeles.
// Today follows the org zone. An open weekly $7 pledge starting
// 2026-09-27 is $0 before that local day and $1 on it (one inclusive
// civil day). A closed week through 2026-10-03 is $7 once it has started.
const LA_EDGE = '2026-09-27T04:17:00.000Z'
const AUCKLAND_10 = '2026-09-26T21:00:00.000Z'
const LA = 'America/Los_Angeles'
const AKL = 'Pacific/Auckland'
const at = (iso) => new Date(iso)
const weekly = { amount: 7, frequency: 'weekly', start_date: '2026-09-27' }
const closed = { ...weekly, end_date: '2026-10-03' }
const oneDay = { ...weekly, end_date: '2026-09-27' }

check('open.la.edge', expectedPeriodTotal(weekly, at(LA_EDGE), LA), 0)
check('open.akl.edge', expectedPeriodTotal(weekly, at(LA_EDGE), AKL), 1)
check('open.utc.edge', expectedPeriodTotal(weekly, at(LA_EDGE), 'UTC'), 1)
check('open.missing.edge', expectedPeriodTotal(weekly, at(LA_EDGE), ''), 1)
check('open.invalid.edge', expectedPeriodTotal(weekly, at(LA_EDGE), 'Not/AZone'), 1)
check('open.la.akl10', expectedPeriodTotal(weekly, at(AUCKLAND_10), LA), 0)
check('open.akl.akl10', expectedPeriodTotal(weekly, at(AUCKLAND_10), AKL), 1)

// Local midnight of the start day, and the second before it.
check('open.la.before-midnight', expectedPeriodTotal(weekly, at('2026-09-27T06:59:59.000Z'), LA), 0)
check('open.la.at-midnight', expectedPeriodTotal(weekly, at('2026-09-27T07:00:00.000Z'), LA), 1)
check('open.akl.before-midnight', expectedPeriodTotal(weekly, at('2026-09-26T11:59:59.000Z'), AKL), 0)
check('open.akl.at-midnight', expectedPeriodTotal(weekly, at('2026-09-26T12:00:00.000Z'), AKL), 1)

// End date is included. The day after the end does not grow the window.
// Before the local start date the total is 0, closed window or not.
check('closed.la.before-start', expectedPeriodTotal(closed, at(LA_EDGE), LA), 0)
check('closed.akl.on-start', expectedPeriodTotal(closed, at(LA_EDGE), AKL), 7)
check('closed.la.on-end', expectedPeriodTotal(closed, at('2026-10-03T18:00:00.000Z'), LA), 7)
check('closed.la.after-end', expectedPeriodTotal(closed, at('2026-10-04T18:00:00.000Z'), LA), 7)
check('closed.akl.after-end', expectedPeriodTotal(closed, at('2026-10-03T23:00:00.000Z'), AKL), 7)
check('oneday.la.before', expectedPeriodTotal(oneDay, at(LA_EDGE), LA), 0)
check('oneday.akl.on-day', expectedPeriodTotal(oneDay, at(LA_EDGE), AKL), 1)
check('oneday.la.after', expectedPeriodTotal(oneDay, at('2026-09-28T18:00:00.000Z'), LA), 1)

// Before the org's start day the total is $0, open or closed. Returning
// the full weekly amount here is the early return, not proration.
// On the local start day an open weekly $7 is one inclusive day: 7 × 1/7 = $1.
// The same two instants are read once for Los Angeles and once for Auckland.
// 'UTC' is the column default. A closed window includes its end date:
// 2026-09-27 through 2026-09-28 is two days, so $2, not $1 and not $7.
const twoDay = { ...weekly, end_date: '2026-09-28' }
const UTC_BEFORE = '2026-09-26T23:00:00.000Z'
check('before-start.open.la', expectedPeriodTotal(weekly, at(LA_EDGE), LA), 0)
check('before-start.closed.la', expectedPeriodTotal(closed, at(LA_EDGE), LA), 0)
check('before-start.open.utc', expectedPeriodTotal(weekly, at(UTC_BEFORE), 'UTC'), 0)
check('start-day.open.akl', expectedPeriodTotal(weekly, at(LA_EDGE), AKL), 1)
check('start-day.open.la', expectedPeriodTotal(weekly, at('2026-09-27T07:00:00.000Z'), LA), 1)
check('start-day.open.utc', expectedPeriodTotal(weekly, at(LA_EDGE), 'UTC'), 1)
check('same-instant.edge.la', expectedPeriodTotal(weekly, at(LA_EDGE), LA), 0)
check('same-instant.edge.akl', expectedPeriodTotal(weekly, at(LA_EDGE), AKL), 1)
check('same-instant.akl10.la', expectedPeriodTotal(weekly, at(AUCKLAND_10), LA), 0)
check('same-instant.akl10.akl', expectedPeriodTotal(weekly, at(AUCKLAND_10), AKL), 1)
check('default-utc.on-start', expectedPeriodTotal(weekly, at(LA_EDGE), 'UTC'), 1)
check('inclusive-end.before', expectedPeriodTotal(twoDay, at(LA_EDGE), LA), 0)
check('inclusive-end.on-start', expectedPeriodTotal(twoDay, at(LA_EDGE), AKL), 2)
check('inclusive-end.on-end', expectedPeriodTotal(twoDay, at('2026-09-28T20:00:00.000Z'), 'UTC'), 2)
check('inclusive-end.after', expectedPeriodTotal(twoDay, at('2026-09-29T20:00:00.000Z'), 'UTC'), 2)

const when = eventAssignmentWhen('2026-09-27', '10:00')
check('event.assignment', when, ' on 9/27/2026 at 10:00')

// Days since contact use the parish's civil today, not UTC.
check('care.la.edge.same', daysSinceCivilDay('2026-09-26', at(LA_EDGE), LA), 0)
check('care.la.edge.next', daysSinceCivilDay('2026-09-27', at(LA_EDGE), LA), -1)
check('care.akl.edge.same', daysSinceCivilDay('2026-09-27', at(LA_EDGE), AKL), 0)
check('care.akl.edge.prior', daysSinceCivilDay('2026-09-26', at(LA_EDGE), AKL), 1)
check('care.akl.akl10.prior', daysSinceCivilDay('2026-09-26', at(AUCKLAND_10), AKL), 1)
check('care.la.akl10.same', daysSinceCivilDay('2026-09-26', at(AUCKLAND_10), LA), 0)
check('care.utc.edge.prior', daysSinceCivilDay('2026-09-26', at(LA_EDGE), 'nope'), 1)
check('care.la.before-midnight', daysSinceCivilDay('2026-09-26', at('2026-09-27T06:59:59.000Z'), LA), 0)
check('care.la.at-midnight', daysSinceCivilDay('2026-09-27', at('2026-09-27T07:00:00.000Z'), LA), 0)
check('care.null', daysSinceCivilDay(null, at(LA_EDGE), LA), null)

await migrateOnce()
const server = await bindServer()
const orgIds = []
try {
  const stamp = `${Date.now()}`
  const slug = tz.replace(/[^a-z0-9]/gi, '_')
  const parish = await createOrg(server, {
    organizationName: `Pledge ${slug} ${stamp}`,
    name: 'Admin',
    email: `pledge_${slug}_${stamp}@example.com`,
    password: 'pledge-period-pw-1',
  }, '10.252.0.8')
  const diocese = await createOrg(server, {
    organizationName: `Diocese ${slug} ${stamp}`,
    name: 'Canon',
    email: `dio_${slug}_${stamp}@example.com`,
    password: 'pledge-period-pw-1',
    organizationType: 'diocese',
  }, '10.252.0.9')
  if (parish.status !== 201 || diocese.status !== 201) {
    fails.push({ name: 'signup', parish: parish.status, diocese: diocese.status })
  } else {
    const parishId = parish.body.user.organization.id
    const dioceseId = diocese.body.user.organization.id
    orgIds.push(parishId, dioceseId)
    const op = provisioningOperatorOrgId()
    if (op) orgIds.push(op)

    const sub = await pool.query(
      `INSERT INTO ochr_report_submissions
         (organization_id, diocese_org_id, period_start, period_end, status, totals_json, review_note)
       VALUES ($1, $2, '2026-09-27', '2026-10-03', 'returned', '{"totals":{}}', 'Please look again')
       RETURNING id`,
      [parishId, dioceseId],
    )
    await pool.query(
      `INSERT INTO ochr_report_review_notes
         (diocese_org_id, submission_id, body, visibility, agreed_next_step, follow_up_on, author_name)
       VALUES ($1, $2, 'Read the period together', 'shared', 'Send the figures', '2026-09-27', 'Canon')`,
      [dioceseId, sub.rows[0].id],
    )
    await pool.query(
      `INSERT INTO ochr_parish_timeline
         (diocese_org_id, parish_org_id, kind, summary, occurred_on, visibility)
       VALUES ($1, $2, 'note', 'Shared a note', '2026-09-27', 'shared')`,
      [dioceseId, parishId],
    )

    const { rows: tzRows } = await pool.query(
      'SELECT timezone FROM ochr_organizations WHERE id = $1',
      [parishId],
    )
    const storedZone = tzRows[0]?.timezone
    check('org.default.timezone', storedZone, 'UTC')
    const bare = {
      id: -1,
      amount: 7,
      frequency: 'weekly',
      start_date: '2026-09-27',
      end_date: null,
      donor_email: null,
      member_id: null,
    }
    const beforeStart = await attachFulfillment(parishId, [bare], at('2026-09-26T23:00:00.000Z'))
    check('org.default.before-start', beforeStart[0]?.period_total, 0)
    const onStart = await attachFulfillment(parishId, [bare], at(LA_EDGE))
    check('org.default.on-start', onStart[0]?.period_total, 1)

    const standing = JSON.parse(JSON.stringify(await standingFor(parishId, dioceseId)))
    check('standing.period_start', standing.with_us?.[0]?.period_start, '2026-09-27')
    check('standing.period_end', standing.with_us?.[0]?.period_end, '2026-10-03')
    const periodLine = standing.notices?.find(n => typeof n.period === 'string')?.period
    check('standing.period_line', periodLine, '2026-09-27 to 2026-10-03')
    check('standing.occurred_on', standing.notices?.find(n => n.kind === 'note')?.on, '2026-09-27')
    const follow = standing.notices?.find(n => n.detail)?.detail
    check('standing.follow_up', follow?.includes('2026-09-27'), true)

    const { rows } = await pool.query(`SELECT '2026-09-27'::date AS joined_date`)
    const joined = rows[0].joined_date
    const anniversaryDay = joined.toISOString
      ? joined.toISOString().slice(0, 10)
      : String(joined).slice(0, 10)
    check('birthday.joined_date', anniversaryDay, '2026-09-27')
  }
} catch (err) {
  fails.push({ name: 'threw', got: err?.message || String(err) })
} finally {
  if (orgIds.length) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = ANY($1::int[])', [orgIds]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
}

if (fails.length) {
  console.error(JSON.stringify({ tz, ok: false, fails }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ tz, ok: true }))
