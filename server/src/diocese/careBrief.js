// The Parish Care Brief (CARE.2).
//
// "Artifacts outlive dashboards." This is the one thing in the diocesan
// product that leaves the building — printed, carried into a bishop's
// visit or a deanery meeting, annotated in pen, and kept. It is treated
// with more care than the dashboard that produced it.
//
// WHAT IT IS FOR
//
// Somebody is about to speak with this parish and has ten minutes to
// remember who they are. Not to assess them. The brief answers: who are
// they, what has been happening, what did we agree, and what is the next
// faithful action.
//
// THREE RULES IT KEEPS
//
// 1. CONTEXT BEFORE ACTION. The situation and the recent history come
//    first; the next step comes after. A brief that opens with a task
//    turns a conversation into an errand.
//
// 2. NO CONTACT DETAILS WITHOUT THE ROLE TO SEE THEM. Names and roles are
//    context. Phone numbers and addresses are personal data, and a printed
//    page has no access control once it is on a table. Only diocesan
//    leadership gets them, and the brief says so on its face when it has
//    withheld something rather than silently omitting it.
//
// 3. DIOCESE-ONLY NOTES DO NOT PRINT BY DEFAULT. The timeline distinguishes
//    'diocese' from 'shared'; a brief that might be left on a sacristy
//    table carries the shared record unless the preparer deliberately asks
//    for the internal one.
//
// AND ONE THING IT REFUSES TO DO
//
// It carries no score, no ranking, no comparison to other parishes, and no
// automated conclusion about how the parish is doing. It reports what
// happened and what was agreed. The judgement belongs to the person
// holding the paper.

import pool from '../db.js'
import { careStatusFor } from './careStatus.js'
import { resolveLiturgicalContext } from '../routes/liturgical.js'

import { leadershipFor } from '../traditions/index.js'

// Diocesan leadership (admin on the diocese org) may see contact details on
// a printed page. Diocesan support staff may not — not because they are
// less trusted, but because the paper outlives the reason it was printed.
export function mayPrintContacts(role) {
  return role === 'admin'
}

export async function buildCareBrief({ dioceseOrgId, parishOrgId, role, includeInternal = false }) {
  const { rows: aff } = await pool.query(
    `SELECT a.grant_level, a.status AS affiliation_status,
            r.name AS region_name,
            p.name AS parish_name, p.address, p.tradition, p.service_times,
            d.name AS diocese_name
       FROM ochr_diocese_affiliations a
       JOIN ochr_organizations p ON p.id = a.parish_org_id
       JOIN ochr_organizations d ON d.id = a.diocese_org_id
       LEFT JOIN ochr_diocese_regions r ON r.id = a.region_id
      WHERE a.diocese_org_id = $1 AND a.parish_org_id = $2
        AND a.status IN ('active', 'suspended')`,
    [dioceseOrgId, parishOrgId]
  )
  if (!aff.length) return null
  const a = aff[0]

  const visibility = includeInternal ? ['diocese', 'shared'] : ['shared']

  const [support, submissions, followups, transitions, timeline, contacts] = await Promise.all([
    // A count, never the tickets. These are the parish's messages to
    // OpenChurch (065: the parish and the vendor, nobody else), and this
    // brief is printed and carried out of the building — the one artifact
    // where a leaked sentence cannot be taken back.
    pool.query(
      `SELECT count(*)::int AS n
         FROM ochr_support_tickets
        WHERE organization_id = $1 AND status NOT IN ('resolved','closed')`, [parishOrgId]),
    pool.query(
      `SELECT to_char(period_start,'YYYY-MM-DD') AS period_start,
              to_char(period_end,'YYYY-MM-DD') AS period_end, status
         FROM ochr_report_submissions
        WHERE organization_id = $1 AND diocese_org_id = $2
        ORDER BY period_end DESC LIMIT 4`, [parishOrgId, dioceseOrgId]),
    pool.query(
      `SELECT context, next_action, owner_name, to_char(due_on,'YYYY-MM-DD') AS due_on
         FROM ochr_parish_followups
        WHERE diocese_org_id = $1 AND parish_org_id = $2 AND state = 'open'
        ORDER BY due_on NULLS LAST LIMIT 6`, [dioceseOrgId, parishOrgId]),
    pool.query(
      `SELECT kind, to_char(began_on,'YYYY-MM-DD') AS began_on, continuity_needs, support_plan
         FROM ochr_parish_transitions
        WHERE diocese_org_id = $1 AND parish_org_id = $2 AND state = 'watching'
        ORDER BY began_on DESC NULLS LAST`, [dioceseOrgId, parishOrgId]),
    pool.query(
      `SELECT kind, summary, to_char(occurred_on,'YYYY-MM-DD') AS occurred_on, actor_name
         FROM ochr_parish_timeline
        WHERE diocese_org_id = $1 AND parish_org_id = $2 AND visibility = ANY($3)
        ORDER BY occurred_on DESC, id DESC LIMIT 8`, [dioceseOrgId, parishOrgId, visibility]),
    // Clergy and key contacts are members of the PARISH's own org. The
    // diocese sees who they are; whether it sees how to reach them is the
    // role question above.
    // An ALLOWLIST, not "has a role". ochr_clients.role defaults to
    // 'Member' (migrate.js:126, and clients.js defaults it on create and on
    // CSV import), so `btrim(role) <> ''` matched essentially every
    // parishioner and ORDER BY name LIMIT 8 printed the first eight
    // alphabetically — with phone and email — onto a page that leaves the
    // building. Whoever read that brief was reading a slice of the parish
    // roster, not its leadership.
    //
    // The list comes from the parish's OWN tradition, because "leadership"
    // is a vocabulary question: this parish's Rector and Wardens are another
    // parish's Pastor and Trustees, and a single hard-coded set printed
    // nobody at all for four of the five traditions we support.
    //
    // status = 'active' as well: an archived member had no business on it.
    pool.query(
      `SELECT name, role, email, phone
         FROM ochr_clients
        WHERE organization_id = $1
          AND status = 'active'
          AND btrim(lower(role)) = ANY($2)
        ORDER BY name LIMIT 8`, [parishOrgId, leadershipFor(a.tradition)]),
  ])

  const last = timeline.rows[0]?.occurred_on ?? null
  const openSupport = support.rows[0]?.n ?? 0
  const status = careStatusFor({
    openSupportRequests: openSupport,
    submissionsAwaitingReview: submissions.rows.filter(s => s.status === 'submitted').length,
    daysSinceLastContact: last ? Math.round((new Date() - new Date(last)) / 86_400_000) : null,
    openFollowUps: followups.rows.length,
    activeTransitions: transitions.rows.length,
  })

  const today = new Date().toISOString().slice(0, 10)
  // The Church Year is real operational context, not decoration: whether a
  // visit falls in Lent or in Ordinary Time changes the conversation.
  const liturgical = await resolveLiturgicalContext(today, parishOrgId)

  const showContacts = mayPrintContacts(role)
  const people = contacts.rows.map(c => ({
    name: c.name,
    role: c.role,
    ...(showContacts ? { email: c.email, phone: c.phone } : {}),
  }))

  return {
    prepared_on: today,
    diocese: a.diocese_name,
    parish: {
      name: a.parish_name,
      address: showContacts ? a.address : null,
      region: a.region_name,
      tradition: a.tradition,
      service_times: a.service_times,
      affiliation_status: a.affiliation_status,
      sharing: a.grant_level,
    },
    church_year: {
      season: liturgical?.season ?? null,
      feast: liturgical?.feast_name ?? null,
      colour: liturgical?.color ?? null,
      ordinary_block: liturgical?.ordinary_block ?? null,
    },
    // Context first. The next step comes after it, never before.
    situation: status,
    recent_history: timeline.rows,
    current_work: {
      // A number, not the tickets. See the query above.
      open_support_requests: openSupport,
      reports: submissions.rows,
      transitions: transitions.rows,
    },
    agreed_next_steps: followups.rows,
    people,
    // Stated on the face of the brief rather than left to be noticed.
    withheld: showContacts
      ? null
      : 'Contact details and the parish address are withheld on this copy. Diocesan leadership may prepare a copy that includes them.',
    internal_included: includeInternal,
    footer:
      'Prepared from what the diocesan office has recorded. It reports what happened and what was agreed; ' +
      'it does not assess the parish, and it is not a comparison with any other parish.',
  }
}
