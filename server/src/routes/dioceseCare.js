// Parish Care (CARE.1) — the diocesan office's working view of a parish.
//
//   GET   /api/diocese/care                     → the care list
//   GET   /api/diocese/care/:parishId           → context panel + timeline
//   GET   /api/diocese/care/:parishId/brief     → the printable brief's data
//   POST  /api/diocese/care/:parishId/brief     → record that one was prepared
//   POST  /api/diocese/care/:parishId/timeline  → write to the record
//   GET   /api/diocese/care/followups           → the office's private memory
//   POST  /api/diocese/care/:parishId/followups
//   PATCH /api/diocese/care/followups/:id
//   POST  /api/diocese/care/:parishId/transitions
//   PATCH /api/diocese/care/transitions/:id
//   GET   /api/diocese/care/submissions/:id/review → the review view
//   POST  /api/diocese/care/submissions/:id/reviewed
//   POST  /api/diocese/care/submissions/:id/notes  → shared report review
//
// EVERY QUERY JOINS THROUGH ochr_diocese_affiliations, INCLUDING the three
// /submissions/:id/* routes — those are keyed on a submission id and it is
// tempting to scope them by s.diocese_org_id alone, which is what they did
// until 24 Aug. That column is a permanent stamp; it does not expire when a
// parish leaves. Care routes require a live grant (active, known
// grant_level) via liveGrantLevel / liveAffiliationSql. GET
// /submissions/:id/review still uses LIVE_AFFILIATION, which admits
// suspended, but while suspended that route returns account lines only.
// Review notes and linked follow-ups are empty unless liveGrantLevel says
// the affiliation is active. A diocese can only
// ever reach a parish it is actually affiliated with, and the mount is
// already behind requireOrgType('diocese'), so a parish token cannot reach
// any path in this file at all.
//
// Nothing here computes or stores a score. Care status is derived at read
// time by diocese/careStatus.js and always arrives with the sentence that
// produced it.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'
import { careStatusFor } from '../diocese/careStatus.js'
import { daysSinceCivilDay } from '../utils/civilDay.js'
import { buildCareBrief, isPastoralLead } from '../diocese/careBrief.js'
import { liveAffiliationSql, liveGrantLevel } from '../diocese/parishGrant.js'

const router = Router()

// The live-affiliation guard, as a SQL fragment, so a route that reads or
// writes a parish's data has one thing to add rather than eleven lines to
// copy. Written as a fragment rather than a helper function because these
// are single-statement routes: splitting the check into a separate round
// trip would make it possible to pass the check and then act on a row that
// changed underneath it.
//
// This exists because copying is exactly how the bug happened. The same
// EXISTS clause was added to diocese.js:339 as an audit follow-up, with the
// comment "Review requires a LIVE affiliation" — and the three
// /submissions/:id/* routes in THIS file, written earlier against
// s.diocese_org_id alone, were never updated. diocese_org_id is a permanent
// stamp on the submission row; nothing clears it when a parish leaves.
//
// Verified 24 Aug against a running pair. After POST /api/affiliation/leave:
// /api/diocese/submissions returned 0 rows and /parishes/:id/financials
// returned 404 — both correct — while /care/submissions/:id/review returned
// 200 with the parish's name and every account line, and both write routes
// still landed on the parish's own record.
//
// THIS FRAGMENT STILL ADMITS SUSPENDED. It is used only by
// GET /submissions/:id/review, and only so that route can still return
// account lines. While suspended it returns account lines only: review
// notes and linked follow-ups are withheld unless liveGrantLevel says the
// affiliation is active. Do not change the account-line path from a
// care-privacy edit. Every other care route uses liveGrantLevel /
// liveAffiliationSql, which require an active affiliation and a known grant.
const LIVE_AFFILIATION = `
  EXISTS (
    SELECT 1 FROM ochr_diocese_affiliations a
     WHERE a.diocese_org_id = s.diocese_org_id
       AND a.parish_org_id  = s.organization_id
       AND a.status IN ('active', 'suspended')
  )`

// The grant a parish has given this diocese right now, or null if the
// covenant has ended. 'summary' is the default and the more private of the
// two: it releases totals and rollup groups but never per-account lines.
// Still treats suspended as live, so GET /submissions/:id/review can return
// account lines for a suspended detail grant. That path is unchanged.
// Notes and follow-ups on the same route do not use this function; they
// use liveGrantLevel and are empty while suspended.
async function currentGrant(dioceseOrgId, parishOrgId) {
  const { rows } = await pool.query(
    `SELECT grant_level FROM ochr_diocese_affiliations
      WHERE diocese_org_id = $1 AND parish_org_id = $2
        AND status IN ('active', 'suspended')
      LIMIT 1`,
    [dioceseOrgId, parishOrgId])
  return rows[0]?.grant_level ?? null
}

// Confirms the parish has a LIVE grant with THIS diocese and returns the
// affiliation. Every parish-scoped handler starts here; a 404 rather than
// a 403 so the existence of an unaffiliated parish is not confirmed.
//
// The status list below is the current covenant row (at most one of
// invited / active / suspended). Whether that row releases anything is
// liveGrantLevel: invited and suspended return null, the same as a missing
// row.
async function affiliated(dioceseOrgId, parishOrgId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.status, a.grant_level, a.region_id, r.name AS region_name,
            p.name AS parish_name, p.slug AS parish_slug, p.address, p.tradition,
            p.service_times, p.timezone
       FROM ochr_diocese_affiliations a
       JOIN ochr_organizations p ON p.id = a.parish_org_id
       LEFT JOIN ochr_diocese_regions r ON r.id = a.region_id
      WHERE a.diocese_org_id = $1 AND a.parish_org_id = $2
        AND a.status IN ('invited', 'active', 'suspended')`,
    [dioceseOrgId, parishOrgId]
  )
  const row = rows[0] ?? null
  if (!liveGrantLevel(row)) return null
  return row
}

// Strip what the grant does not cover. 'detail' releases the per-account
// lines; anything else (including a grant that has ended) releases totals and
// rollup groups only. Mirrors diocese.js's per-parish drill-down deliberately
// — if these two ever disagree about what a grant means, the more private one
// should win, and that is the one a reader of either file should be able to
// find.
//
// AN ALLOWLIST, NOT A DENYLIST, and the difference is the whole point.
//
// This used to read `const { accounts, ...rest } = totals_json` — name the
// one thing to withhold, release everything else. That is default-open: the
// day anyone adds a key to totals_json, a summary-grant diocese receives it
// with no code change here, no review, and no signal that anything widened.
// periodTotals.js produces { groups, accounts, totals } today, and there is
// nothing stopping it producing more tomorrow — it is the natural place to
// add a per-donor breakdown, a payroll line, a top-gifts list.
//
// The grant level is a parish's ONE meaningful control over its own books.
// A control that has to be updated every time somebody else adds a field is
// not a control, it is a promise to remember.
const SUMMARY_KEYS = ['groups', 'totals']

function withGrant(submission, grant) {
  if (!submission?.totals_json) return submission
  if (grant === 'detail') return submission
  const src = submission.totals_json
  // `in` throws on a primitive, and totals_json is JSONB — which can hold a
  // scalar perfectly legally, and which we know ad-hoc scripts have written
  // to before (the 999-race-sim row in the migration ledger was exactly
  // that). The denylist this replaced degraded on a malformed value; an
  // allowlist that throws would turn it into a 500 on a chancery review
  // screen, which is a worse answer than the one it replaced.
  //
  // Unrecognisable shape releases NOTHING. Failing closed is the whole
  // direction of travel for a grant: if we cannot tell what this is, the
  // parish has not agreed to share it.
  if (typeof src !== 'object' || src === null || Array.isArray(src)) {
    return { ...submission, totals_json: {} }
  }
  const totals_json = {}
  for (const k of SUMMARY_KEYS) if (k in src) totals_json[k] = src[k]
  return { ...submission, totals_json }
}

const actor = req => ({
  id: req.user?.id ?? null,
  name: req.user?.name ?? null,
  email: req.user?.email ?? null,
})

const text = (v, min = 1, max = 2000) => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s.length < min || s.length > max) return null
  return s
}

// Writing to the institutional record. Called from the handlers that
// represent something a person did, never from a computation.
async function recordOnTimeline(conn, { dioceseOrgId, parishOrgId, kind, summary, detail, visibility, req }) {
  const a = actor(req)
  await conn.query(
    `INSERT INTO ochr_parish_timeline
       (diocese_org_id, parish_org_id, kind, summary, detail, visibility,
        actor_user_id, actor_name, actor_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [dioceseOrgId, parishOrgId, kind, summary, detail ?? null,
     visibility ?? 'diocese', a.id, a.name, a.email]
  )
}

// ── The care list ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const dio = req.organizationId
  // Trimmed to null rather than '' so an empty search box is "no filter"
  // instead of a LIKE '%%' that quietly matches rows with a NULL address.
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 80) : null
  const wantedState = ['ready', 'review_together', 'offer_support', 'awaiting_update']
    .includes(req.query.state) ? req.query.state : null
  try {
    const { rows } = await pool.query(
      `SELECT p.id AS parish_org_id, p.name AS parish_name, r.name AS region_name,
              (SELECT count(*)::int FROM ochr_support_tickets t
                WHERE t.organization_id = p.id AND t.status NOT IN ('resolved', 'closed')) AS open_support,
              (SELECT count(*)::int FROM ochr_report_submissions s
                WHERE s.organization_id = p.id AND s.diocese_org_id = $1
                  AND s.status = 'submitted') AS awaiting_review,
              (SELECT count(*)::int FROM ochr_parish_followups f
                WHERE f.diocese_org_id = $1 AND f.parish_org_id = p.id AND f.state = 'open') AS open_followups,
              (SELECT count(*)::int FROM ochr_parish_transitions tr
                WHERE tr.diocese_org_id = $1 AND tr.parish_org_id = p.id AND tr.state = 'watching') AS active_transitions,
              (SELECT max(tl.occurred_on) FROM ochr_parish_timeline tl
                WHERE tl.diocese_org_id = $1 AND tl.parish_org_id = p.id) AS last_contact,
              p.address, p.tradition, p.timezone
         FROM ochr_diocese_affiliations a
         JOIN ochr_organizations p ON p.id = a.parish_org_id
         LEFT JOIN ochr_diocese_regions r ON r.id = a.region_id
        WHERE a.diocese_org_id = $1 AND ${liveAffiliationSql('a')}
          -- Search across the four things a staff member actually has in
          -- their head: the parish, roughly where it is, its deanery, and
          -- its tradition. Unaccented ILIKE on purpose — this is a filter
          -- for a list of dozens, not a search engine, and a fuzzy matcher
          -- here would return surprises rather than the parish they meant.
          AND ($2::text IS NULL
               OR p.name ILIKE '%' || $2 || '%'
               OR p.address ILIKE '%' || $2 || '%'
               OR r.name ILIKE '%' || $2 || '%'
               OR p.tradition ILIKE '%' || $2 || '%')
        ORDER BY p.name`,
      [dio, q]
    )

    const today = new Date()
    const parishes = rows.map(r => {
      const days = daysSinceCivilDay(r.last_contact, today, r.timezone)
      const status = careStatusFor({
        openSupportRequests: r.open_support,
        submissionsAwaitingReview: r.awaiting_review,
        daysSinceLastContact: days,
        openFollowUps: r.open_followups,
        activeTransitions: r.active_transitions,
      })
      return {
        parish_org_id: r.parish_org_id,
        parish_name: r.parish_name,
        region: r.region_name,
        tradition: r.tradition && r.tradition !== 'general' ? r.tradition : null,
        status,
        open_followups: r.open_followups,
        last_contact: r.last_contact,
      }
    })

    // Counted, not ranked. The tallies exist so a staff member can see the
    // shape of the morning, not so parishes can be compared.
    //
    // Counted over the SEARCHED set, before the state filter is applied.
    //
    // So: searching narrows what the chips describe, and clicking a chip
    // narrows further within that. The chips therefore never promise a
    // parish that clicking them cannot produce — which is what would happen
    // if they always reported diocese-wide totals. A search that matches
    // nothing has nothing to count, and says so.
    const counts = {}
    for (const p of parishes) counts[p.status.key] = (counts[p.status.key] ?? 0) + 1

    const shown = wantedState ? parishes.filter(p => p.status.key === wantedState) : parishes

    res.json({
      parishes: shown, counts,
      total: parishes.length,
      filter: { state: wantedState, q },
    })
  } catch (err) {
    monitor.error('care.list', err, { orgId: dio })
    res.status(500).json({ error: 'Failed to load parish care' })
  }
})

// ── The office's own follow-ups, across every parish ─────────────────────
router.get('/followups', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, p.name AS parish_name,
              to_char(f.due_on,'YYYY-MM-DD') AS due_on,
              to_char(f.settled_at,'YYYY-MM-DD') AS settled_on,
              -- A DATE has neither a time nor a timezone; sending one that
              -- says "T00:00:00.000Z" is a small lie about the column and
              -- it renders raw on the page. Same defect as DIO.6, caught a
              -- second time — every date out of this file goes through
              -- to_char now.
              to_char(s.period_start,'YYYY-MM-DD') AS period_start,
              to_char(s.period_end,'YYYY-MM-DD')   AS period_end
         FROM ochr_parish_followups f
         JOIN ochr_organizations p ON p.id = f.parish_org_id
         JOIN ochr_diocese_affiliations a
           ON a.diocese_org_id = f.diocese_org_id
          AND a.parish_org_id = f.parish_org_id
          AND ${liveAffiliationSql('a')}
         LEFT JOIN ochr_report_submissions s ON s.id = f.from_submission_id
        WHERE f.diocese_org_id = $1 AND f.state = $2
        ORDER BY f.due_on NULLS LAST, f.created_at`,
      [req.organizationId,
       ['open', 'done', 'let_go'].includes(req.query.state) ? req.query.state : 'open']
    )
    res.json({ followups: rows })
  } catch (err) {
    monitor.error('care.followups.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load follow-ups' })
  }
})

// PATCH /followups/:id (CARE.3) — settle it, hand it to someone, or both.
//
// The table has carried `owner_user_id` and `completion_note` since 074 and
// no route ever wrote either, so a follow-up could be created and closed
// and never belong to anybody. Three things are possible here now:
//
//   ASSIGN      hand it to a named person in this chancery, or to nobody.
//   DONE        with a light outcome note — what actually happened.
//   LET GO      with an optional reason.
//
// "Let go" keeps its own reason field rather than sharing completion_note,
// because the two say different things and a report that cannot tell them
// apart teaches an office to record neither honestly.
router.patch('/followups/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const body = req.body ?? {}
  const state = ['open', 'done', 'let_go'].includes(body.state) ? body.state : null
  const reassigning = Object.prototype.hasOwnProperty.call(body, 'owner_user_id')
  if (!state && !reassigning) {
    return res.status(400).json({ error: 'Send a state (open, done or let_go) or an owner_user_id' })
  }

  try {
    // An owner must be a real user in THIS chancery. Anything else and a
    // follow-up could name a canon from another diocese.
    let ownerId = null, ownerName = null
    if (reassigning && body.owner_user_id != null) {
      const { rows: u } = await pool.query(
        `SELECT id, name FROM ochr_users WHERE id = $1 AND organization_id = $2`,
        [Number(body.owner_user_id), req.organizationId]
      )
      if (!u.length) return res.status(400).json({ error: 'That person is not in this diocese' })
      ownerId = u[0].id; ownerName = u[0].name
    }

    const a = actor(req)
    const settling = state === 'done' || state === 'let_go'
    const { rows } = await pool.query(
      `UPDATE ochr_parish_followups
          SET state            = COALESCE($1::text, state),
              completion_note  = COALESCE($2::text, completion_note),
              let_go_reason    = COALESCE($3::text, let_go_reason),
              owner_user_id    = CASE WHEN $4 THEN $5::integer ELSE owner_user_id END,
              owner_name       = CASE WHEN $4 THEN $6::text ELSE owner_name END,
              settled_at       = CASE WHEN $7 THEN NOW() ELSE settled_at END,
              settled_by_name  = CASE WHEN $7 THEN $8::text ELSE settled_by_name END,
              updated_at       = NOW()
        WHERE id = $9 AND diocese_org_id = $10
          AND EXISTS (
            SELECT 1 FROM ochr_diocese_affiliations a
             WHERE a.diocese_org_id = ochr_parish_followups.diocese_org_id
               AND a.parish_org_id = ochr_parish_followups.parish_org_id
               AND ${liveAffiliationSql('a')}
          )
        RETURNING *`,
      [state,
       state === 'done' ? text(body.completion_note, 1, 2000) : null,
       state === 'let_go' ? text(body.let_go_reason, 1, 2000) : null,
       reassigning, ownerId, ownerName,
       settling, settling ? a.name : null,
       id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('care.followups.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update follow-up' })
  }
})

// GET /team (CARE.3) — who a follow-up can be handed to.
//
// Names and roles only. This is a picker, not a directory: it carries no
// email or anything else a chancery list has no reason to hand around.
router.get('/team', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, role, pastoral_lead
         FROM ochr_users WHERE organization_id = $1 ORDER BY name`,
      [req.organizationId]
    )
    res.json({ team: rows })
  } catch (err) {
    monitor.error('care.team', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the team' })
  }
})

router.patch('/transitions/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const state = ['watching', 'settled'].includes(req.body?.state) ? req.body.state : null
  if (!state) return res.status(400).json({ error: 'state must be watching or settled' })
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_parish_transitions
          SET state = $1, support_plan = COALESCE($2, support_plan), updated_at = NOW()
        WHERE id = $3 AND diocese_org_id = $4
          AND EXISTS (
            SELECT 1 FROM ochr_diocese_affiliations a
             WHERE a.diocese_org_id = ochr_parish_transitions.diocese_org_id
               AND a.parish_org_id = ochr_parish_transitions.parish_org_id
               AND ${liveAffiliationSql('a')}
          )
        RETURNING *`,
      [state, text(req.body?.support_plan, 1, 2000), id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('care.transitions.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update transition' })
  }
})

// ── Shared review of a prepared report (CARE.3) ──────────────────────────
//
// A note could be written and never read back. This is the other half: the
// report in its parish context, the notes on it, and the follow-ups that
// came out of the conversation.
//
// TWO STREAMS, ONE PAGE. Notes carry a visibility, and only pastoral
// leadership sees the internal ones. Everything a parish is entitled to
// see is marked shared and stays that way, so nobody has to remember which
// list they are typing into.
router.get('/submissions/:id/review', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const lead = isPastoralLead(req.user)
  try {
    const { rows: sub } = await pool.query(
      `SELECT s.id, s.status, s.review_note,
              to_char(s.period_start,'YYYY-MM-DD') AS period_start,
              to_char(s.period_end,'YYYY-MM-DD')   AS period_end,
              s.totals_json, s.submitted_at,
              to_char(s.reviewed_together_at,'YYYY-MM-DD') AS reviewed_together_on,
              s.reviewed_together_name,
              s.organization_id AS parish_org_id,
              p.name AS parish_name, p.tradition
         FROM ochr_report_submissions s
         JOIN ochr_organizations p ON p.id = s.organization_id
        WHERE s.id = $1 AND s.diocese_org_id = $2
          AND ${LIVE_AFFILIATION}`,
      [id, req.organizationId]
    )
    if (!sub.length) return res.status(404).json({ error: 'Not found' })

    // The grant line. totals_json carries per-account detail whether or not
    // the parish agreed to share it, so this route was handing a summary-
    // grant diocese exactly what /parishes/:id/financials withholds from it
    // thirty lines away in diocese.js — the parish's one meaningful control
    // over its own books, defeated by a different URL. Verified 24 Aug on a
    // running pair: the sanctioned route released no accounts, this one
    // released all of them.
    const grant = await currentGrant(req.organizationId, sub[0].parish_org_id)

    // Account lines follow `grant` above, including when the affiliation is
    // suspended. That residual stays. Care notes and the follow-ups linked
    // to this report do not: they need a live grant, same as the list and
    // the detail page. A suspended lead does not receive the internal note.
    const { rows: aff } = await pool.query(
      `SELECT status, grant_level FROM ochr_diocese_affiliations
        WHERE diocese_org_id = $1 AND parish_org_id = $2
          AND status IN ('active', 'suspended')
        LIMIT 1`,
      [req.organizationId, sub[0].parish_org_id])
    const careLive = liveGrantLevel(aff[0]) != null

    const [notes, followups] = careLive
      ? await Promise.all([
          pool.query(
            `SELECT id, body, visibility, agreed_next_step,
                    to_char(follow_up_on,'YYYY-MM-DD') AS follow_up_on,
                    author_name, created_at
               FROM ochr_report_review_notes
              WHERE submission_id = $1 AND diocese_org_id = $2
                AND ($3::boolean OR visibility = 'shared')
              ORDER BY created_at`,
            [id, req.organizationId, lead]),
          pool.query(
            `SELECT id, context, next_action, owner_name, state,
                    to_char(due_on,'YYYY-MM-DD') AS due_on
               FROM ochr_parish_followups
              WHERE from_submission_id = $1 AND diocese_org_id = $2
              ORDER BY created_at`,
            [id, req.organizationId]),
        ])
      : [{ rows: [] }, { rows: [] }]

    res.json({
      submission: withGrant(sub[0], grant),
      notes: notes.rows,
      followups: followups.rows,
      may_see_internal: careLive && lead,
      // Which half of its books the parish agreed to share. On the face of
      // the response for the same reason `withheld` is: a chancery reading
      // totals without account lines should be able to see WHY, rather than
      // wonder whether the data is missing.
      grant_level: grant,
      // Said on the face of the response rather than inferred from a
      // missing key, the same way the brief states what it withheld.
      withheld: !careLive
        ? 'Notes and follow-ups are not shown. This affiliation is not active.'
        : (lead ? null
          : 'Internal diocesan notes are not shown. Pastoral leadership may see them.'),
    })
  } catch (err) {
    monitor.error('care.review.get', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load the review' })
  }
})

// POST /submissions/:id/reviewed (CARE.3) — "we sat down and read this."
//
// DELIBERATELY NOT A STATUS CHANGE. `status` stays submitted/approved/
// returned, because 'approved' gates the assessment roll-up and overloading
// it would be a money change dressed as a vocabulary change. Reading a
// report together is a different fact from accepting it for assessment, and
// it implies no judgement about the parish — which is the whole point of
// having somewhere else to record it.
router.post('/submissions/:id/reviewed', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const a = actor(req)
    const { rows } = await pool.query(
      `UPDATE ochr_report_submissions
          SET reviewed_together_at = NOW(),
              reviewed_together_by = $1,
              reviewed_together_name = $2
        WHERE id = $3 AND diocese_org_id = $4
          AND EXISTS (
            SELECT 1 FROM ochr_diocese_affiliations a
             WHERE a.diocese_org_id = ochr_report_submissions.diocese_org_id
               AND a.parish_org_id  = ochr_report_submissions.organization_id
               AND ${liveAffiliationSql('a')}
          )
        RETURNING id, organization_id,
                  to_char(period_start,'YYYY-MM-DD') AS period_start,
                  to_char(period_end,'YYYY-MM-DD')   AS period_end`,
      [a.id, a.name, id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })

    const r = rows[0]
    await recordOnTimeline(pool, {
      dioceseOrgId: req.organizationId, parishOrgId: r.organization_id,
      kind: 'report',
      summary: `Read the ${r.period_start} to ${r.period_end} report together.`,
      // Shared: the parish should know its report was actually looked at by
      // a person. Silence after submitting anything to a chancery is the
      // commonest complaint there is.
      visibility: 'shared', req,
    })
    res.json({ reviewed: r })
  } catch (err) {
    monitor.error('care.review.mark', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to record the review' })
  }
})

router.post('/submissions/:id/notes', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const body = text(req.body?.body, 1, 4000)
  if (!body) return res.status(400).json({ error: 'A note needs a body' })
  const visibility = req.body?.visibility === 'shared' ? 'shared' : 'diocese'

  try {
    const { rows: sub } = await pool.query(
      `SELECT s.id, s.organization_id, p.name AS parish_name
         FROM ochr_report_submissions s
         JOIN ochr_organizations p ON p.id = s.organization_id
        WHERE s.id = $1 AND s.diocese_org_id = $2
          AND EXISTS (
            SELECT 1 FROM ochr_diocese_affiliations a
             WHERE a.diocese_org_id = s.diocese_org_id
               AND a.parish_org_id = s.organization_id
               AND ${liveAffiliationSql('a')}
          )`,
      [id, req.organizationId]
    )
    if (!sub.length) return res.status(404).json({ error: 'Not found' })

    const a = actor(req)
    const conn = await pool.connect()
    try {
      await conn.query('BEGIN')
      const { rows } = await conn.query(
        `INSERT INTO ochr_report_review_notes
           (diocese_org_id, submission_id, body, visibility, agreed_next_step,
            follow_up_on, author_user_id, author_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.organizationId, id, body, visibility,
         text(req.body?.agreed_next_step, 1, 2000),
         /^\d{4}-\d{2}-\d{2}$/.test(req.body?.follow_up_on ?? '') ? req.body.follow_up_on : null,
         a.id, a.name]
      )
      await recordOnTimeline(conn, {
        dioceseOrgId: req.organizationId, parishOrgId: sub[0].organization_id,
        kind: 'report',
        summary: rows[0].agreed_next_step
          ? 'Report reviewed together; a next step was agreed.'
          : 'A note was added to a report under review.',
        detail: rows[0].agreed_next_step ?? null,
        visibility, req,
      })
      await conn.query('COMMIT')
      res.status(201).json(rows[0])
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => {})
      throw e
    } finally { conn.release() }
  } catch (err) {
    monitor.error('care.reviewNote', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to save the note' })
  }
})

// ── One parish: context, current work, and the record ────────────────────
router.get('/:parishId', async (req, res) => {
  const parishId = requireIntParam(req, res, 'parishId'); if (parishId === null) return
  const dio = req.organizationId
  try {
    const aff = await affiliated(dio, parishId)
    if (!aff) return res.status(404).json({ error: 'Not found' })

    const [support, submissions, followups, transitions, timeline] = await Promise.all([
      // A COUNT, never the tickets themselves. ochr_support_tickets is the
      // parish's channel to OpenChurch, not to its diocese: migration 065
      // sets the posture as "parish admins see ONLY their own org's
      // tickets; the vendor sees all", and grant_level covers financial
      // detail, not this. A parish writing "payroll crashes entering Fr X's
      // stipend, he's under investigation" wrote that to us.
      //
      // The count stays because it is a real care signal — a parish
      // struggling with the software is worth a call — and it carries no
      // content. Anything more needs a share the parish grants.
      pool.query(
        `SELECT count(*)::int AS n
           FROM ochr_support_tickets
          WHERE organization_id = $1 AND status NOT IN ('resolved', 'closed')`, [parishId]),
      pool.query(
        `SELECT id, to_char(period_start,'YYYY-MM-DD') AS period_start,
                to_char(period_end,'YYYY-MM-DD') AS period_end, status, submitted_at, review_note
           FROM ochr_report_submissions
          WHERE organization_id = $1 AND diocese_org_id = $2
          ORDER BY period_end DESC LIMIT 8`, [parishId, dio]),
      pool.query(
        `SELECT * FROM ochr_parish_followups
          WHERE diocese_org_id = $1 AND parish_org_id = $2 AND state = 'open'
          ORDER BY due_on NULLS LAST, created_at`, [dio, parishId]),
      pool.query(
        `SELECT * FROM ochr_parish_transitions
          WHERE diocese_org_id = $1 AND parish_org_id = $2 AND state = 'watching'
          ORDER BY began_on DESC NULLS LAST`, [dio, parishId]),
      // CARE.3 — internal entries are for pastoral leadership only.
      //
      // This used to return everything to every diocesan user. The office's
      // private note about a parish — "the treasurer has been unwell, be
      // gentle about the deadline" — is exactly the kind of confidence a
      // parish extends to a canon and not to whoever else happens to hold a
      // chancery login. The visibility column existed and nothing read it.
      pool.query(
        `SELECT id, kind, summary, detail, to_char(occurred_on,'YYYY-MM-DD') AS occurred_on,
                visibility, actor_name, created_at
           FROM ochr_parish_timeline
          WHERE diocese_org_id = $1 AND parish_org_id = $2
            AND ($3::boolean OR visibility = 'shared')
          ORDER BY occurred_on DESC, id DESC LIMIT 60`,
        [dio, parishId, isPastoralLead(req.user)]),
    ])

    const last = timeline.rows[0]?.occurred_on ?? null
    // The count now comes from count(*), so it is the TRUE number rather
      // than the length of a LIMIT 10 page — twelve open tickets used to
      // report as ten here while the dashboard's subselect said twelve.
    const openSupport = support.rows[0]?.n ?? 0
    const status = careStatusFor({
      openSupportRequests: openSupport,
      submissionsAwaitingReview: submissions.rows.filter(s => s.status === 'submitted').length,
      daysSinceLastContact: daysSinceCivilDay(last, new Date(), aff.timezone),
      openFollowUps: followups.rows.length,
      activeTransitions: transitions.rows.length,
    })

    res.json({
      parish: {
        id: parishId, name: aff.parish_name, slug: aff.parish_slug,
        address: aff.address, tradition: aff.tradition,
        service_times: aff.service_times,
        region: aff.region_name, grant_level: aff.grant_level,
        affiliation_status: aff.status,
      },
      status,
      current_work: {
        // A number, not a list. See the query above for why.
        open_support_requests: openSupport,
        submissions: submissions.rows,
        followups: followups.rows,
        transitions: transitions.rows,
      },
      timeline: timeline.rows,
    })
  } catch (err) {
    monitor.error('care.parish', err, { orgId: dio, parishId })
    res.status(500).json({ error: 'Failed to load parish context' })
  }
})

router.post('/:parishId/timeline', async (req, res) => {
  const parishId = requireIntParam(req, res, 'parishId'); if (parishId === null) return
  const summary = text(req.body?.summary, 3, 500)
  const kind = ['visit', 'note', 'support_request', 'transition', 'report', 'followup', 'brief']
    .includes(req.body?.kind) ? req.body.kind : 'note'
  if (!summary) return res.status(400).json({ error: 'A timeline entry needs a summary' })
  try {
    if (!(await affiliated(req.organizationId, parishId))) return res.status(404).json({ error: 'Not found' })
    const conn = await pool.connect()
    try {
      await recordOnTimeline(conn, {
        dioceseOrgId: req.organizationId, parishOrgId: parishId, kind, summary,
        detail: text(req.body?.detail, 1, 4000),
        visibility: req.body?.visibility === 'shared' ? 'shared' : 'diocese',
        req,
      })
      res.status(201).json({ ok: true })
    } finally { conn.release() }
  } catch (err) {
    monitor.error('care.timeline.post', err, { orgId: req.organizationId, parishId })
    res.status(500).json({ error: 'Failed to write to the record' })
  }
})

router.post('/:parishId/followups', async (req, res) => {
  const parishId = requireIntParam(req, res, 'parishId'); if (parishId === null) return
  const context = text(req.body?.context, 3, 2000)
  const nextAction = text(req.body?.next_action, 3, 2000)
  if (!context || !nextAction) {
    return res.status(400).json({ error: 'A follow-up needs a context and a next action' })
  }
  try {
    if (!(await affiliated(req.organizationId, parishId))) return res.status(404).json({ error: 'Not found' })
    const a = actor(req)

    // Optional owner — a follow-up may be raised on someone else's behalf.
    let ownerId = null, ownerName = null
    if (req.body?.owner_user_id != null) {
      const { rows: u } = await pool.query(
        `SELECT id, name FROM ochr_users WHERE id = $1 AND organization_id = $2`,
        [Number(req.body.owner_user_id), req.organizationId])
      if (!u.length) return res.status(400).json({ error: 'That person is not in this diocese' })
      ownerId = u[0].id; ownerName = u[0].name
    }

    // Optional provenance: this action came out of reading a report
    // together. Scoped to this diocese AND this parish, so a follow-up can
    // never cite another parish's submission as its reason.
    let fromSubmissionId = null
    if (req.body?.from_submission_id != null) {
      const { rows: sub } = await pool.query(
        `SELECT id FROM ochr_report_submissions
          WHERE id = $1 AND diocese_org_id = $2 AND organization_id = $3`,
        [Number(req.body.from_submission_id), req.organizationId, parishId])
      if (!sub.length) return res.status(400).json({ error: 'That report is not this parish\'s' })
      fromSubmissionId = sub[0].id
    }

    const { rows } = await pool.query(
      `INSERT INTO ochr_parish_followups
         (diocese_org_id, parish_org_id, context, next_action, owner_user_id, owner_name,
          due_on, created_by, created_by_name, from_submission_id)
       VALUES ($1, $2, $3, $4, COALESCE($8::integer, $5), COALESCE($9::text, $6), $7, $5, $6, $10::bigint) RETURNING *`,
      [req.organizationId, parishId, context, nextAction, a.id, a.name,
       /^\d{4}-\d{2}-\d{2}$/.test(req.body?.due_on ?? '') ? req.body.due_on : null,
       ownerId, ownerName, fromSubmissionId]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('care.followups.post', err, { orgId: req.organizationId, parishId })
    res.status(500).json({ error: 'Failed to save the follow-up' })
  }
})

router.post('/:parishId/transitions', async (req, res) => {
  const parishId = requireIntParam(req, res, 'parishId'); if (parishId === null) return
  const KINDS = ['clergy_arrival', 'clergy_departure', 'administrator_departure', 'music_staff',
                 'search_period', 'records_handoff', 'onboarding_support']
  if (!KINDS.includes(req.body?.kind)) {
    return res.status(400).json({ error: `kind must be one of: ${KINDS.join(', ')}` })
  }
  try {
    if (!(await affiliated(req.organizationId, parishId))) return res.status(404).json({ error: 'Not found' })
    const a = actor(req)
    const conn = await pool.connect()
    try {
      await conn.query('BEGIN')
      const { rows } = await conn.query(
        `INSERT INTO ochr_parish_transitions
           (diocese_org_id, parish_org_id, kind, began_on, expected_until, notes,
            continuity_needs, support_plan, owner_user_id, owner_name, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9) RETURNING *`,
        [req.organizationId, parishId, req.body.kind,
         /^\d{4}-\d{2}-\d{2}$/.test(req.body?.began_on ?? '') ? req.body.began_on : null,
         /^\d{4}-\d{2}-\d{2}$/.test(req.body?.expected_until ?? '') ? req.body.expected_until : null,
         text(req.body?.notes, 1, 4000), text(req.body?.continuity_needs, 1, 4000),
         text(req.body?.support_plan, 1, 4000), a.id, a.name]
      )
      await recordOnTimeline(conn, {
        dioceseOrgId: req.organizationId, parishOrgId: parishId, kind: 'transition',
        summary: `A ${req.body.kind.replaceAll('_', ' ')} was recorded, so the office can accompany the parish through it.`,
        detail: text(req.body?.notes, 1, 4000), visibility: 'diocese', req,
      })
      await conn.query('COMMIT')
      res.status(201).json(rows[0])
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => {})
      throw e
    } finally { conn.release() }
  } catch (err) {
    monitor.error('care.transitions.post', err, { orgId: req.organizationId, parishId })
    res.status(500).json({ error: 'Failed to save the transition' })
  }
})

// ── The brief ────────────────────────────────────────────────────────────
//
// Regenerated from live context every time rather than stored. A brief
// filed six months ago and reprinted today would be a stale page wearing
// today's date, which is worse than no brief at all — what IS stored is
// the fact that somebody prepared one, so the record can say a brief was
// prepared before the visit.
router.get('/:parishId/brief', async (req, res) => {
  const parishId = requireIntParam(req, res, 'parishId'); if (parishId === null) return
  try {
    const brief = await buildCareBrief({
      dioceseOrgId: req.organizationId,
      parishOrgId: parishId,
      user: req.user,
      // Internal notes are opt-IN, and only a pastoral lead may ask.
      // A viewer or other non-lead passing ?internal=1 gets the shared
      // record, the same rule as the detail route (CARE.3). A brief that
      // might be left on a sacristy table carries the shared record unless
      // leadership deliberately asks for the internal one.
      includeInternal: req.query.internal === '1' && isPastoralLead(req.user),
    })
    if (!brief) return res.status(404).json({ error: 'Not found' })
    res.json(brief)
  } catch (err) {
    monitor.error('care.brief', err, { orgId: req.organizationId, parishId })
    res.status(500).json({ error: 'Failed to prepare the brief' })
  }
})

router.post('/:parishId/brief', async (req, res) => {
  const parishId = requireIntParam(req, res, 'parishId'); if (parishId === null) return
  try {
    if (!(await affiliated(req.organizationId, parishId))) return res.status(404).json({ error: 'Not found' })
    const a = actor(req)
    const purpose = text(req.body?.purpose, 1, 500)
    const conn = await pool.connect()
    try {
      await conn.query('BEGIN')
      const { rows } = await conn.query(
        `INSERT INTO ochr_parish_care_briefs
           (diocese_org_id, parish_org_id, purpose, prepared_by, prepared_by_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.organizationId, parishId, purpose, a.id, a.name]
      )
      await recordOnTimeline(conn, {
        dioceseOrgId: req.organizationId, parishOrgId: parishId, kind: 'brief',
        summary: purpose
          ? `A care brief was prepared, ahead of ${purpose}.`
          : 'A care brief was prepared.',
        visibility: 'diocese', req,
      })
      await conn.query('COMMIT')
      res.status(201).json(rows[0])
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => {})
      throw e
    } finally { conn.release() }
  } catch (err) {
    monitor.error('care.brief.record', err, { orgId: req.organizationId, parishId })
    res.status(500).json({ error: 'Failed to record the brief' })
  }
})

export default router
