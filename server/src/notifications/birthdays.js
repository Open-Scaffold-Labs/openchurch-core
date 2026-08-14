// Daily enqueue job for member birthdays + membership anniversaries.
// Pulls members whose birth_date / joined_date matches tomorrow's
// month-day across every org, and schedules one notification per
// admin per match. Stub transport writes them to the log; a real
// transport (when one lands) sends emails the next morning.
//
// Scheduled send time: 9 AM UTC tomorrow. Not timezone-aware in v1
// — most US churches sit in 6 AM–11 AM local for that hour. When
// orgs gain a timezone field, this is the spot that consults it.
//
// Idempotency: this function does NOT guard against being called
// twice the same day. The Vercel cron config (or whatever drives
// it) is responsible for "exactly once per day per org." If the
// job fires twice, you get duplicate notifications. Acceptable for
// v1; a "last_birthday_run_at" timestamp on ochr_organizations
// would close the gap when warranted.

import pool from '../db.js'
import { scheduleNotification } from './scheduler.js'
import { monitor } from '../monitoring/index.js'

// 9 AM UTC. Real timezones come later.
const SEND_AT_HOUR_UTC = 9

function tomorrow(now = new Date()) {
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
    SEND_AT_HOUR_UTC, 0, 0
  ))
  return d
}

function ymd(date) {
  // YYYY-MM-DD in UTC. Used for human-readable strings in the
  // template body, not for SQL — SQL gets month/day numbers.
  return date.toISOString().slice(0, 10)
}

// Years between two dates, rounded down. anniversary_date is
// joined_date + N years where N is the answer.
function yearsBetween(joinedDateStr, ref) {
  const j = new Date(joinedDateStr + 'T00:00:00Z')
  const ry = ref.getUTCFullYear()
  let years = ry - j.getUTCFullYear()
  // If we haven't passed the M/D yet this year, subtract one.
  const refMD = ref.getUTCMonth() * 100 + ref.getUTCDate()
  const joinMD = j.getUTCMonth() * 100 + j.getUTCDate()
  if (refMD < joinMD) years -= 1
  return years
}

// Public entry point. Returns counts so the operator (or cron run
// log) can see what happened.
export async function enqueueDailyBirthdayReminders({ now = new Date() } = {}) {
  const sendAt = tomorrow(now)
  const tMonth = sendAt.getUTCMonth() + 1
  const tDay   = sendAt.getUTCDate()

  let birthdaysEnqueued = 0
  let anniversariesEnqueued = 0
  let orgsScanned = 0

  try {
    // Walk every org. Small enough at OpenChurch scale to do in
    // one pass; if we ever cross thousands of orgs we'll batch.
    const { rows: orgs } = await pool.query(
      'SELECT id, name FROM ochr_organizations'
    )

    for (const org of orgs) {
      orgsScanned++

      // Pull all admins in the org once — every match gets enqueued
      // for every admin recipient.
      const { rows: admins } = await pool.query(
        `SELECT id, email, name FROM ochr_users
          WHERE organization_id = $1 AND role = 'admin'`,
        [org.id]
      )
      if (!admins.length) continue

      // Birthdays — members whose birth_date M/D matches tomorrow.
      const { rows: birthdayMembers } = await pool.query(
        `SELECT id, name, birth_date FROM ochr_clients
          WHERE organization_id = $1
            AND birth_date IS NOT NULL
            AND EXTRACT(MONTH FROM birth_date) = $2
            AND EXTRACT(DAY   FROM birth_date) = $3`,
        [org.id, tMonth, tDay]
      )
      for (const member of birthdayMembers) {
        for (const admin of admins) {
          await scheduleNotification({
            organizationId:    org.id,
            userId:            admin.id,
            recipient:         admin.email,
            notification_type: 'member_birthday',
            sendAt,
            vars: {
              recipient_name: admin.name,
              member_name:    member.name,
              birthday_date:  ymd(sendAt),
            },
          })
          birthdaysEnqueued++
        }
      }

      // Anniversaries — same M/D match on joined_date, plus we
      // compute years-since for the template body.
      const { rows: anniversaryMembers } = await pool.query(
        `SELECT id, name, joined_date FROM ochr_clients
          WHERE organization_id = $1
            AND joined_date IS NOT NULL
            AND EXTRACT(MONTH FROM joined_date) = $2
            AND EXTRACT(DAY   FROM joined_date) = $3`,
        [org.id, tMonth, tDay]
      )
      for (const member of anniversaryMembers) {
        const years = yearsBetween(
          member.joined_date.toISOString
            ? member.joined_date.toISOString().slice(0, 10)
            : String(member.joined_date).slice(0, 10),
          sendAt
        )
        // Skip the same-day-joined edge case (years === 0) — no
        // value in alerting "they joined today, tomorrow."
        if (years <= 0) continue
        for (const admin of admins) {
          await scheduleNotification({
            organizationId:    org.id,
            userId:            admin.id,
            recipient:         admin.email,
            notification_type: 'member_anniversary',
            sendAt,
            vars: {
              recipient_name:    admin.name,
              member_name:       member.name,
              years:             years,
              anniversary_date:  ymd(sendAt),
            },
          })
          anniversariesEnqueued++
        }
      }
    }
  } catch (err) {
    monitor.error('birthdays.enqueue', err)
    throw err
  }

  return { orgs_scanned: orgsScanned, birthdays_enqueued: birthdaysEnqueued, anniversaries_enqueued: anniversariesEnqueued }
}
