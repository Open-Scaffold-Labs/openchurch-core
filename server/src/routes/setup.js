// Getting settled — a parish's first week, without a progress bar.
//
// WHY THERE IS NO DENOMINATOR.
//
// The Dashboard used to carry a "Get started" card with a bar filling to
// `doneCount / totalCount * 100%`. It is a good instinct badly aimed:
// people genuinely do like finishing things, and a filled bar is a small
// reward. But a bar has two halves, and the empty half is the message. It
// says there is a standard, WE set it, and you are below it — to a parish
// secretary who did not ask to become a software user, on the first
// morning she opens the thing. Anxiety is a defect, and a percentage is
// an anxiety generator with a denominator we invented.
//
// The substitute keeps the reward and drops the gap: A LEDGER THAT ONLY
// GROWS. `in_place` returns things that are TRUE, each with the date it
// became true, and never returns a row for something that is not. There
// is no total, so there is no fraction, so there is nothing to be behind
// on — and a parish with three entries reads them as three things done,
// not as three of eight. A passport with three stamps is a record of
// travel; nobody feels 37% travelled.
//
// The suggestions are deliberately NOT the complement of that ledger. If
// `begin_here` returned exactly the items missing from `in_place`, a
// person would reassemble the denominator in their head and we would
// have shipped the same bar with extra steps. So suggestions are a SHORT,
// ROLE-SHAPED, ROTATING few — at most three, drawn from what this person
// can actually do today — and the set is never presented as exhaustive.
//
// DERIVED, NOT STORED. Every entry below is computed from the parish's
// own data at read time. A stored "context confirmed" flag would keep
// congratulating a parish for an address it deleted last week. The only
// stored things are the two decisions in migration 088: one person's
// "later", and the parish's "we have chosen to defer this".
//
// ROLE FILTERING IS AT THE SOURCE. A viewer does not receive invitation
// suggestions with a disabled flag for the client to hide; the server
// does not put them in the payload. The rule is that the response is
// already the answer for THIS person — a client bug can then fail to
// render something, which is safe, rather than reveal something.

import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { requireRole } from '../middleware/auth.js'

const router = Router()

// EVERY role decision below reads req.user.role, and requireRole is what
// makes that trustworthy: it re-reads the role from the database and
// overwrites the value requireAuth took from the JWT. Without it, a
// demoted admin keeps admin sight of this page until her token expires —
// up to seven days — because PATCH /api/users/:id/role does not bump
// token_version. Listing all three roles makes this a refresh rather than
// a gate; the actual gates are per-handler below.
router.use(requireRole('admin', 'staff', 'viewer'))

// ── what is true, as of now ──────────────────────────────────────────────

// Each entry is { key, on, detail? }. `on` is the date it became true —
// a ledger entry without a date is a claim; with one it is a record.
// Anything not true is simply absent. There is no third state, and in
// particular there is no 'pending', because a pending row IS the empty
// half of the bar wearing a different hat.
async function inPlace(orgId, role) {
  const [org, people, imports, records] = await Promise.all([
    pool.query(
      `SELECT name, created_at, address, timezone, tradition, org_type
         FROM ochr_organizations WHERE id = $1`, [orgId]),
    // A pending invitation is NOT access. POST /api/users/invite writes
    // the row immediately with invite_accepted_at NULL and a password
    // nobody holds, so counting it made the ledger say "colleagues have
    // been given access" of a parish where the email is still unopened —
    // and put that person in the printed handover under "People with
    // access". `invited_at IS NULL` is the directly-created case
    // (including the founding admin), which is real access.
    pool.query(
      `SELECT role, COUNT(*)::int AS n FROM ochr_users
        WHERE organization_id = $1
          AND (invited_at IS NULL OR invite_accepted_at IS NOT NULL)
        GROUP BY role`, [orgId]),
    pool.query(
      `SELECT id, kind, source_name, committed_at, receipt, undone_at
         FROM ochr_import_batches
        WHERE organization_id = $1 AND status = 'committed' AND undone_at IS NULL
        ORDER BY committed_at DESC LIMIT 1`, [orgId]),
    pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM ochr_clients
           WHERE organization_id = $1 AND name NOT LIKE '[Sample]%') AS members,
         (SELECT COUNT(*)::int FROM ochr_calendar_events
           WHERE organization_id = $1 AND title NOT LIKE '[Sample]%') AS events,
         (SELECT COUNT(*)::int FROM ochr_funds
           WHERE organization_id = $1 AND name NOT LIKE '[Sample]%') AS funds`,
      [orgId]),
  ])

  const o = org.rows[0]
  if (!o) return { entries: [], org: null, latestImport: null, people: [] }

  const day = v => (v == null ? null : new Date(v).toISOString().slice(0, 10))
  const entries = []

  entries.push({ key: 'setup.inPlace.workspace', on: day(o.created_at), detail: { parish: o.name } })

  // "Context confirmed" is not a checkbox somebody ticked; it is the
  // address actually being there. Delete the address and this entry goes
  // away, which is the point of deriving it.
  //
  // NOT `o.address && o.timezone`. `timezone` is NOT NULL DEFAULT 'UTC'
  // (migration 040) and signup never sets it, so it is truthy for every
  // parish that ever existed and the condition silently collapsed to
  // `o.address`. Worse, the same expression suppressed the "confirm the
  // parish details" suggestion, so a Californian parish that entered only
  // a street address was told its details were on file, never asked for a
  // timezone, and quietly ran its schedule on UTC. Exactly the class of
  // default-read-as-choice the tradition check above exists to prevent —
  // one column over.
  if (o.address) {
    entries.push({ key: 'setup.inPlace.context', on: null })
  }
  // 'general' is the FALLBACK migration 072 gives a parish that did not
  // name a tradition — not a tradition it chose. Treating it as one made
  // the ledger claim "the parish reads in its own tradition" of every
  // parish that skipped the question at signup, which is the exact class
  // of quiet untruth this ledger exists to avoid. A ledger is only worth
  // reading if nothing in it has to be discounted.
  if (o.tradition && o.tradition !== 'general') {
    entries.push({ key: 'setup.inPlace.tradition', on: null, detail: { tradition: o.tradition } })
  }

  // Colleagues, counted — but the ROLES are only itemised for an admin.
  // A viewer learning the exact composition of the staff list from an
  // orientation page is a small leak with no upside.
  const total = people.rows.reduce((a, r) => a + r.n, 0)
  if (total > 1) {
    entries.push({
      key: 'setup.inPlace.people',
      on: null,
      detail: role === 'admin'
        ? { count: total, by_role: Object.fromEntries(people.rows.map(r => [r.role, r.n])) }
        : { count: total },
    })
  }

  const imp = imports.rows[0] ?? null
  if (imp) {
    entries.push({
      key: 'setup.inPlace.import',
      on: day(imp.committed_at),
      detail: { imported: imp.receipt?.imported ?? null, source: imp.source_name ?? null },
    })
  }

  const r = records.rows[0]
  if (r.members > 0) entries.push({ key: 'setup.inPlace.members', on: null, detail: { count: r.members } })
  if (r.events > 0)  entries.push({ key: 'setup.inPlace.events',  on: null, detail: { count: r.events } })
  if (r.funds > 0)   entries.push({ key: 'setup.inPlace.funds',   on: null, detail: { count: r.funds } })

  return { entries, org: o, latestImport: imp, people: people.rows, counts: r }
}

// ── a good place to begin ────────────────────────────────────────────────

// What an administrator may mark "we have decided to leave this for
// later". Not everything is: the import receipt is a thing to read, not a
// task to defer, and browsing records is not a decision. Defined here
// rather than beside the route because beginHere stamps each suggestion
// with whether it is deferrable, so the button and the endpoint can never
// disagree.
const DEFERRABLE = new Set([
  'setup.begin.invite', 'setup.begin.context', 'setup.begin.migration',
  'setup.begin.week', 'setup.begin.funds', 'setup.begin.followUp',
])

// At most three, and the cap is the design rather than a layout
// convenience: a list long enough to scan for what you have not done is
// a checklist, and a checklist has a denominator. Ordered by what this
// person can do today, then trimmed.
const CAP = 3

// A deferral describes a decision about something NOT yet done. Once the
// thing is done, the deferral is not history, it is a contradiction: the
// page would show "Parish information was brought in · since 2 April" and
// "Left for later, on purpose — Bring in what the parish already has"
// at the same time, and so would the printed handover. So a mark is
// retired the moment its subject becomes true. Derived, like everything
// else here, rather than requiring somebody to remember to clear it.
function markIsStale(key, { org, latestImport, peopleCount }) {
  switch (key) {
    case 'setup.begin.migration':
    case 'setup.begin.followUp':
      return Boolean(latestImport)
    case 'setup.begin.context': return Boolean(org?.address)
    case 'setup.begin.invite':  return peopleCount > 1
    default: return false
  }
}

function beginHere({ role, org, latestImport, counts, marks, orgType }) {
  // A diocesan workspace is not a parish and must not be handed parish
  // setup actions. It has its own surfaces.
  if (orgType === 'diocese') return []

  const deferred = new Set(marks.map(m => m.item_key))
  const out = []
  // `deferrable` travels with the suggestion so the client can only offer
  // "we will come back to this" where the server will actually accept it.
  // It used to render the button on every item, including the receipt —
  // which is not deferrable and is always the FIRST suggestion after an
  // import, so the most prominent control on the page was a guaranteed
  // 400 and an error toast.
  const add = (key, to, opts = {}) => {
    if (deferred.has(key)) return
    out.push({ key, to, deferrable: DEFERRABLE.has(key), ...opts })
  }

  // Import suggestions are ADMIN-ONLY, and the first version of this was
  // not — it offered every viewer a link to /migration/:id/receipt.
  // Migration Studio is admin-only in the navigation, so its receipt is
  // an admin artifact too, and the link would have disclosed both that an
  // import happened and the batch's id to somebody who cannot open it.
  // A suggestion a reader will be refused at is worse than no suggestion;
  // a suggestion that leaks on the way to being refused is worse again.
  if (role === 'admin') {
    if (latestImport) {
      // The receipt first — what arrived is the thing a parish most wants
      // to see and least knows to look for.
      add('setup.begin.receipt', `/migration/${latestImport.id}/receipt`)
      const held = (latestImport.receipt?.held_for_follow_up ?? 0)
        + (latestImport.receipt?.duplicates_left_for_review ?? 0)
      if (held > 0) add('setup.begin.followUp', '/clients', { count: held })
    } else {
      add('setup.begin.migration', '/migration')
    }
  }

  if (role === 'admin') {
    if (!org?.address) add('setup.begin.context', '/settings')
    add('setup.begin.invite', '/team')
  }

  // One rhythm, chosen for the role. Staff get the week ahead because
  // that is the Tuesday-morning job; admins get it too when nothing more
  // pressing is queued.
  if (role === 'admin' || role === 'staff') {
    add('setup.begin.week', '/schedule')
    // Finance is adminOnly in the navigation, so suggesting it to staff
    // routes them into a page the product deliberately hides from them.
    if (role === 'admin' && counts?.funds > 0) add('setup.begin.funds', '/finance')
  } else {
    // A viewer can read. Offering them a create action they will be
    // refused at is worse than offering nothing.
    add('setup.begin.browse', '/clients')
  }

  return out.slice(0, CAP)
}

// ── GET /api/setup ───────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const orgId = req.organizationId
    const role = req.user?.role ?? 'viewer'

    const [state, dismissal, marksRows, orgTypeRow] = await Promise.all([
      inPlace(orgId, role),
      pool.query(
        `SELECT dismissed_at FROM ochr_setup_dismissals
          WHERE organization_id = $1 AND user_id = $2`, [orgId, req.user.id]),
      pool.query(
        `SELECT item_key, state, noted_by_name, noted_at FROM ochr_setup_marks
          WHERE organization_id = $1 ORDER BY noted_at DESC`, [orgId]),
      pool.query(`SELECT org_type FROM ochr_organizations WHERE id = $1`, [orgId]),
    ])

    const orgType = orgTypeRow.rows[0]?.org_type ?? 'parish'
    const peopleCount = state.people.reduce((a, r) => a + r.n, 0)
    const liveMarks = marksRows.rows.filter(
      m => !markIsStale(m.item_key, { org: state.org, latestImport: state.latestImport, peopleCount }))

    res.json({
      parish: state.org?.name ?? null,
      role,
      // The client uses this to decide whether to show the quiet card on
      // the Dashboard. The PAGE itself is always reachable — dismissing
      // hides a suggestion, never a destination.
      dismissed_at: dismissal.rows[0]?.dismissed_at ?? null,
      in_place: state.entries,
      begin_here: beginHere({
        role, org: state.org, latestImport: state.latestImport,
        counts: state.counts, marks: liveMarks, orgType,
      }),
      // ADMIN ONLY. `noted_by` is a snapshotted full name, and the items
      // themselves name admin-only surfaces — a read-only volunteer does
      // not need to learn who deferred the migration, or that Migration
      // Studio and Org details exist.
      deferred: role === 'admin'
        ? liveMarks.map(m => ({
            item_key: m.item_key, noted_by: m.noted_by_name ?? null, noted_at: m.noted_at,
          }))
        : [],
      // Import context, only for someone who may see it. Migration Studio
      // is admin-only, so its receipt is too.
      import_context: state.latestImport && role === 'admin'
        ? {
            id: state.latestImport.id,
            kind: state.latestImport.kind,
            source_name: state.latestImport.source_name,
            committed_at: state.latestImport.committed_at,
            imported: state.latestImport.receipt?.imported ?? 0,
            held_for_follow_up: state.latestImport.receipt?.held_for_follow_up ?? 0,
            duplicates_left_for_review: state.latestImport.receipt?.duplicates_left_for_review ?? 0,
            ignored_columns: state.latestImport.receipt?.ignored_columns ?? [],
            // Verbatim from the receipt. The one sentence about the source
            // file lives in imports.js and is copied nowhere, so this page
            // cannot drift into claiming the file was kept.
            protection: state.latestImport.receipt?.protection ?? null,
            retention_days: state.latestImport.receipt?.retention_days ?? null,
          }
        : null,
      can_invite: role === 'admin',
      can_edit_context: role === 'admin',
      can_import: role === 'admin' && orgType !== 'diocese',
    })
  } catch (err) {
    monitor.error('setup.get', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load getting settled' })
  }
})

// ── come back to this later, and change your mind ────────────────────────

// PER PERSON. See migration 088 for why. Idempotent both ways so a
// double-tap on a phone is not an error the parish has to understand.
router.post('/dismiss', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO ochr_setup_dismissals (organization_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [req.organizationId, req.user.id])
    res.status(204).end()
  } catch (err) {
    monitor.error('setup.dismiss', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save that' })
  }
})

router.delete('/dismiss', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM ochr_setup_dismissals WHERE organization_id = $1 AND user_id = $2`,
      [req.organizationId, req.user.id])
    res.status(204).end()
  } catch (err) {
    monitor.error('setup.undismiss', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save that' })
  }
})

// ── we have decided to leave this for later ──────────────────────────────

// Admin-only, because it is a decision on the parish's behalf. The
// printable record distinguishes "deferred" from "not done", and only
// somebody who can speak for the parish should be able to move an item
// into the first column.
router.post('/later', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only a parish administrator can note this.' })
  }
  const key = String(req.body?.item_key ?? '')
  if (!DEFERRABLE.has(key)) {
    return res.status(400).json({ error: 'Not something that can be left for later.' })
  }
  try {
    await pool.query(
      `INSERT INTO ochr_setup_marks (organization_id, item_key, state, noted_by, noted_by_name)
       VALUES ($1, $2, 'later', $3, $4)
       ON CONFLICT (organization_id, item_key)
       DO UPDATE SET noted_by = EXCLUDED.noted_by,
                     noted_by_name = EXCLUDED.noted_by_name,
                     noted_at = NOW()`,
      [req.organizationId, key, req.user.id, req.user.name ?? null])
    res.status(204).end()
  } catch (err) {
    monitor.error('setup.later', err, { orgId: req.organizationId, key })
    res.status(500).json({ error: 'Failed to save that' })
  }
})

router.delete('/later/:key', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only a parish administrator can note this.' })
  }
  try {
    await pool.query(
      `DELETE FROM ochr_setup_marks WHERE organization_id = $1 AND item_key = $2`,
      [req.organizationId, req.params.key])
    res.status(204).end()
  } catch (err) {
    monitor.error('setup.unlater', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save that' })
  }
})

// ── the First Parish Setup Record ────────────────────────────────────────

// Admin-only, and it is a PRINTABLE ARTIFACT rather than a dashboard —
// artifacts outlive dashboards, and the case this exists for is a
// volunteer handing the parish office to the next volunteer.
//
// What it must never do: imply incompleteness. It has three sections —
// what is in place, what was deliberately left for later, and who has
// access — and no fourth section listing what is missing. "Deferred" is
// stated as a decision the parish made, with a name and a date on it,
// because that is what it was.
router.get('/record', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only a parish administrator can open the setup record.' })
  }
  try {
    const orgId = req.organizationId
    const state = await inPlace(orgId, 'admin')
    if (!state.org) return res.status(404).json({ error: 'Not found' })

    // The parish's own day, not the server's. A Californian parish that
    // signed up at 17:30 on 1 March had its permanent record stamped
    // "established 2026-03-02", and an admin printing at 5pm PT dated it
    // tomorrow — on the one artifact whose whole justification is that it
    // outlives the dashboard and gets read years later.
    const zone = state.org.timezone || 'UTC'
    const localDay = v => (v == null ? null
      : new Date(v).toLocaleDateString('en-CA', { timeZone: zone }))

    const [marks, people] = await Promise.all([
      pool.query(
        `SELECT item_key, noted_by_name, noted_at FROM ochr_setup_marks
          WHERE organization_id = $1 ORDER BY noted_at`, [orgId]),
      // Names and roles, no email addresses. A handover document that
      // travels well is one that does not carry a contact list into
      // whatever drawer it ends up in.
      // Same filter as the people count. An unopened invitation is not
      // access, and this is the document a departing volunteer hands to
      // the next one — listing somebody who has never logged in as having
      // access is precisely the wrong thing to hand over.
      pool.query(
        `SELECT name, role FROM ochr_users
          WHERE organization_id = $1
            AND (invited_at IS NULL OR invite_accepted_at IS NOT NULL)
          ORDER BY role, name`, [orgId]),
    ])

    const imp = state.latestImport
    res.json({
      parish: state.org.name,
      established: localDay(state.org.created_at),
      prepared_on: localDay(new Date()),
      prepared_by: req.user.name ?? null,
      in_place: state.entries,
      // Same staleness filter as the page. A handover that lists a
      // deferral for work the parish has since done reads as a document
      // nobody maintained, which is the opposite of what it is for.
      left_for_later: marks.rows
        .filter(m => !markIsStale(m.item_key, {
          org: state.org,
          latestImport: state.latestImport,
          peopleCount: state.people.reduce((a, r) => a + r.n, 0),
        }))
        .map(m => ({
          item_key: m.item_key,
          noted_by: m.noted_by_name ?? null,
          noted_at: localDay(m.noted_at),
        })),
      access: people.rows.map(p => ({ name: p.name, role: p.role })),
      latest_import: imp
        ? {
            id: imp.id,
            source_name: imp.source_name,
            committed_at: localDay(imp.committed_at),
            // null, not 0. A receipt missing a count is a thing we do not
            // know; printing "0 records on 1 March" states something
            // false with the same confidence as the true lines around it.
            imported: imp.receipt?.imported ?? null,
            held_at_the_time:
              imp.receipt?.held_for_follow_up == null && imp.receipt?.duplicates_left_for_review == null
                ? null
                : (imp.receipt?.held_for_follow_up ?? 0) + (imp.receipt?.duplicates_left_for_review ?? 0),
            // Copied from the receipt rather than rewritten, for the same
            // reason as above: this document must not be the place the
            // promise about the source file quietly changes.
            source_file: imp.receipt?.protection?.source_file ?? null,
          }
        : null,
    })
  } catch (err) {
    monitor.error('setup.record', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to prepare the record' })
  }
})

export default router
