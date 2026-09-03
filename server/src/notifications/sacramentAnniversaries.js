// Weekly sacrament-anniversary digest (Pastoral Intelligence v1).
//
// Sweeps the register for anniversaries landing in the next 7 days
// (baptisms, confirmations, weddings, …) and enqueues ONE digest email
// per admin per org into the scheduled-notifications queue — the same
// queue/drainer everything else rides. Each item carries a pre-written
// outreach note the pastor can copy, personalize, and send: the system
// drafts, a human reaches out. Nothing is ever sent to a member
// automatically.
//
// Idempotency (unlike the birthday job): one digest per org per ISO
// week, enforced via the queue's (source_type, source_id) linkage —
// source_id encodes year+week, so re-running the cron is a no-op.

import pool from '../db.js'
import { scheduleNotification } from './scheduler.js'
import { monitor } from '../monitoring/index.js'

const WINDOW_DAYS = 7

const TYPE_LABELS = {
  baptism:         'Baptism',
  reconciliation:  'First Reconciliation',
  first_communion: 'First Communion',
  confirmation:    'Confirmation',
  marriage:        'Wedding',
  holy_orders:     'Ordination',
  anointing:       'Anointing of the Sick',
}

// Short outreach drafts, one register line each. Deterministic template
// text — pastoral wording is a human's job; these are starting points.
function draftNote(memberFirst, label, years) {
  const yearsPhrase = years === 1 ? 'one year' : `${years} years`
  return `Dear ${memberFirst}, this week marks ${yearsPhrase} since your ${label}. ` +
         `We give thanks to God with you, and you are in our prayers.`
}

// ISO week number (1–53) — used with the year as the dedup key.
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
}

// Public entry point. Returns counts for the cron run log.
export async function enqueueSacramentAnniversaryDigests({ now = new Date() } = {}) {
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const end = new Date(today); end.setDate(end.getDate() + WINDOW_DAYS - 1)
  const sourceId = today.getFullYear() * 100 + isoWeek(today)

  // The distinct calendar months the window touches (≤ 2), so the scan
  // is bounded rather than reading every register in the database.
  const months = new Set()
  for (let d = new Date(today); d <= end; d.setDate(d.getDate() + 1)) months.add(d.getMonth() + 1)

  let orgsScanned = 0
  let digestsEnqueued = 0
  let orgsSkipped = 0

  try {
    const { rows: orgs } = await pool.query('SELECT id, name FROM ochr_organizations')

    for (const org of orgs) {
      orgsScanned++

      // One digest per org per ISO week — the queue is the ledger.
      const { rows: already } = await pool.query(
        `SELECT 1 FROM ochr_scheduled_notifications
          WHERE organization_id = $1 AND source_type = 'sacrament_anniv_digest' AND source_id = $2
          LIMIT 1`,
        [org.id, sourceId]
      )
      if (already.length) { orgsSkipped++; continue }

      const { rows } = await pool.query(
        `SELECT s.type, to_char(s.date, 'YYYY-MM-DD') AS date, c.name AS member_name
           FROM ochr_sacramental_records s
           JOIN ochr_clients c
             ON c.id = s.client_id AND c.organization_id = s.organization_id AND c.status = 'active'
          WHERE s.organization_id = $1 AND s.date IS NOT NULL
            -- REG.1: a voided entry left the working register. The parochial
            -- report already filtered it; this query and /anniversaries did
            -- not, so a pastor was handed a draft note congratulating someone
            -- on a sacrament the parish had struck from the book.
            AND s.voided_at IS NULL
            AND s.type <> 'burial'  -- never auto-draft a burial note (070)
            AND EXTRACT(MONTH FROM s.date) = ANY($2::int[])
          LIMIT 2000`,
        [org.id, [...months]]
      )

      // Same anniversary math as /api/sacraments/anniversaries: the next
      // M/D occurrence, full years only, inside the window.
      const items = []
      for (const r of rows) {
        const [y, m, d] = r.date.split('-').map(Number)
        let annYear = today.getFullYear()
        let next = new Date(annYear, m - 1, d); next.setHours(0, 0, 0, 0)
        if (next < today) { annYear += 1; next = new Date(annYear, m - 1, d); next.setHours(0, 0, 0, 0) }
        const years = annYear - y
        if (years < 1) continue
        if (next >= today && next <= end) {
          items.push({ member: r.member_name, type: r.type, years, when: next })
        }
      }
      if (!items.length) continue

      items.sort((a, b) => a.when - b.when)
      const itemsBlock = items.map((it) => {
        const label = TYPE_LABELS[it.type] ?? it.type
        const whenStr = it.when.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
        const first = String(it.member ?? '').split(' ')[0] || 'Friend'
        return `• ${it.years} ${it.years === 1 ? 'year' : 'years'} since ${it.member}'s ${label} — ${whenStr}\n` +
               `  Draft note: ${draftNote(first, label, it.years)}`
      }).join('\n\n')

      const { rows: admins } = await pool.query(
        `SELECT id, email, name FROM ochr_users
          WHERE organization_id = $1 AND role = 'admin'`,
        [org.id]
      )
      if (!admins.length) continue

      for (const admin of admins) {
        await scheduleNotification({
          organizationId:    org.id,
          userId:            admin.id,
          recipient:         admin.email,
          notification_type: 'sacrament_anniversary_digest',
          sendAt:            new Date(now),
          sourceType:        'sacrament_anniv_digest',
          sourceId,
          vars: {
            recipient_name: admin.name,
            church_name:    org.name,
            count:          String(items.length),
            items_block:    itemsBlock,
          },
        })
        digestsEnqueued++
      }
    }

    return { orgsScanned, digestsEnqueued, orgsSkipped, sourceId }
  } catch (err) {
    monitor.error('sacramentAnniversaries.enqueue', err)
    throw err
  }
}
