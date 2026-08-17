// The Sunday Packet (SPK.1) — "the Thursday Button."
//
//   GET /api/packet?date=YYYY-MM-DD   (default: next Sunday, org timezone)
//
// One call assembles everything a parish secretary spends Thursday
// afternoon copying between four systems:
//
//   · the liturgical day (season, color, feast — parish overrides honored)
//   · the lectionary designation ("Tenth Sunday after Pentecost ·
//     Proper 13 · Year A") — the Ordo lookup, computed
//   · the order of worship (service plan + assignments)
//   · the serving schedule (calendar events that day, with names)
//   · the week of Mass intentions (the sacristy manifest window)
//   · the bulletin's announcements + pastor's note for that week
//
// Read-only aggregation — every section quotes systems of record that
// already exist; nothing here writes. Empty sections return empty, not
// errors: a parish with no bulletin still gets a printable packet.

import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { resolveLiturgicalContext } from './liturgical.js'
import { lectionaryFor } from '../traditions/index.js'
import { traditionFor } from '../traditions/context.js'

const router = Router()

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// Next Sunday (today included) in the org's own timezone — a packet
// printed Thursday evening in California must not point at the wrong
// Sunday because the server lives in UTC.
async function defaultPacketDate(orgId) {
  const { rows } = await pool.query(
    `SELECT to_char(
              (NOW() AT TIME ZONE COALESCE(timezone, 'UTC'))::date
              + ((7 - EXTRACT(DOW FROM (NOW() AT TIME ZONE COALESCE(timezone, 'UTC'))::date)::int) % 7),
              'YYYY-MM-DD') AS sunday
       FROM ochr_organizations WHERE id = $1`,
    [orgId]
  )
  return rows[0]?.sunday
}

router.get('/', async (req, res) => {
  const orgId = req.organizationId
  try {
    const date = ISO_DATE.test(req.query.date ?? '')
      ? req.query.date
      : await defaultPacketDate(orgId)
    if (!date) return res.status(400).json({ error: 'Could not resolve a packet date' })

    const [org, tradition, liturgical, plan, serving, intentions, bulletin] = await Promise.all([
      pool.query('SELECT name FROM ochr_organizations WHERE id = $1', [orgId]),

      // TRAD.1 — which tradition's Sunday designation to print, if any.
      // A 'general' org gets null and the client renders no lectionary
      // line at all, which is the honest answer: printing another
      // tradition's Sunday name is worse than printing none.
      traditionFor(orgId),

      resolveLiturgicalContext(date, orgId),

      // Order of worship for the day (one plan per date in practice).
      pool.query(
        `SELECT p.id, p.title, p.notes,
                COALESCE(json_agg(json_build_object(
                  'position', e.position, 'kind', e.kind, 'title', e.title,
                  'reference', e.reference, 'notes', e.notes,
                  'assigned_name', c.name
                ) ORDER BY e.position, e.id) FILTER (WHERE e.id IS NOT NULL), '[]') AS elements
           FROM ochr_service_plans p
           LEFT JOIN ochr_service_elements e ON e.plan_id = p.id
           LEFT JOIN ochr_clients c
                  ON c.id = e.assigned_client_id AND c.organization_id = p.organization_id
          WHERE p.organization_id = $1 AND p.date = $2::date
          GROUP BY p.id
          ORDER BY p.id
          LIMIT 1`,
        [orgId, date]
      ),

      // Serving schedule: that day's calendar events with assignee names
      // resolved from the assigned_to jsonb id array.
      pool.query(
        `SELECT ce.title, ce.start_time, ce.end_time, ce.type,
                COALESCE(json_agg(cl.name ORDER BY cl.name)
                         FILTER (WHERE cl.id IS NOT NULL), '[]') AS assigned
           FROM ochr_calendar_events ce
           LEFT JOIN LATERAL jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(ce.assigned_to) = 'array'
                       THEN ce.assigned_to ELSE '[]'::jsonb END) AS a(member_id) ON true
           LEFT JOIN ochr_clients cl
                  ON cl.id = NULLIF(a.member_id, '')::bigint
                 AND cl.organization_id = ce.organization_id
          WHERE ce.organization_id = $1 AND ce.date = $2::date
          GROUP BY ce.id
          ORDER BY ce.start_time NULLS LAST, ce.id`,
        [orgId, date]
      ),

      // The sacristy-manifest week beginning on the packet date.
      pool.query(
        `SELECT to_char(mass_date, 'YYYY-MM-DD') AS mass_date, mass_title, mass_time,
                formatted_intention, requested_by, requester_name, stipend, status, note
           FROM ochr_sacristy_weekly_manifest
          WHERE organization_id = $1
            AND mass_date BETWEEN $2::date AND $2::date + 6
          ORDER BY mass_date, mass_time NULLS LAST`,
        [orgId, date]
      ),

      // The bulletin for that Sunday: exact date first, else the most
      // recent one inside the preceding week.
      pool.query(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, title, announcements, pastor_note
           FROM ochr_bulletins
          WHERE organization_id = $1
            AND date BETWEEN $2::date - 6 AND $2::date
          ORDER BY date DESC
          LIMIT 1`,
        [orgId, date]
      ),
    ])

    res.set('Cache-Control', 'private, max-age=60')
    res.json({
      date,
      parish: org.rows[0]?.name ?? null,
      liturgical,
      lectionary: lectionaryFor(tradition, date),
      tradition,
      plan: plan.rows[0] ?? null,
      serving: serving.rows,
      intentions: intentions.rows,
      bulletin: bulletin.rows[0] ?? null,
    })
  } catch (err) {
    monitor.error('packet.get', err, { orgId })
    res.status(500).json({ error: 'Failed to assemble the Sunday packet' })
  }
})

export default router
