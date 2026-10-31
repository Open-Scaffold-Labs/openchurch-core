import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// Folded so "Misa" and "misas" are the same lookup. These are search
// words, not sentences on screen.
const MASS_WORDS = new Set(['mass', 'masses', 'misa', 'misas'])
const PLAN_WORDS = new Set([
  'worship', 'liturgy', 'liturgia', 'plan', 'plans', 'service', 'services',
  'mass', 'masses', 'misa', 'misas', 'celebracion',
])

function foldQuery(value) {
  return String(value).trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

// Each searchable table has a `search_vec` tsvector column maintained
// by Postgres (GENERATED ALWAYS AS … STORED — see migration 009) and
// backed by a GIN index. The previous implementation used
// `ILIKE '%term%'` which can never use an index; this version uses
// `search_vec @@ websearch_to_tsquery('english', $1)` which:
//
//   • Uses the GIN index (sub-millisecond on small tables, scales
//     well into the millions of rows).
//   • Handles user input gracefully — multiple words are AND'd,
//     "quoted phrases" match exactly, leading `-word` negates.
//     No fragile to_tsquery escaping.
//   • Stems via the english config so "scheduling" matches rows
//     containing "scheduled", "groups" matches "group", etc.

// A failed scope used to become []. The handler then answered 200, and the
// palette said the parish had no matches. One failed read fails the search:
// a partial list would still read as the whole parish. The database text
// stays in the log; the response is a fixed sentence.
async function searchScope(scope, sql, params) {
  try {
    const { rows } = await pool.query(sql, params)
    return rows
  } catch (err) {
    monitor.error(`search.${scope}`, err)
    throw new Error('Search failed')
  }
}

// GET /api/search?q=searchterm
// Every sub-query filters by organization_id = $2 so search never
// leaks across tenants.
router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim()
    if (!q) return res.json([])

    const orgId = req.organizationId
    const folded = foldQuery(q)
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
    // A word for the thing, not only a title that happens to contain it.
    // "misa" finds Masses whose titles are "10:00". "plan" finds plans.
    const massWord = MASS_WORDS.has(folded)
    const planWord = PLAN_WORDS.has(folded)
    const mayReadPlans = req.user?.role !== 'viewer'
    // SP-185: Mass intentions are a staff/admin book (same gate as donations).
    const mayReadIntentions = req.user?.role === 'admin' || req.user?.role === 'staff'

    const [clients, events, tasks, staff, donations, plans, masses, intentions] = await Promise.all([
      searchScope('clients',
        `SELECT id, name, COALESCE(email,'') AS email,
                COALESCE(role,'') AS role, COALESCE(status,'') AS status,
                'member'::text AS type
           FROM ochr_clients
          WHERE organization_id = $2
            AND search_vec @@ websearch_to_tsquery('english', $1)
          ORDER BY name LIMIT 5`,
        [q, orgId]
      ),
      searchScope('events',
        `SELECT id, title, COALESCE(service_division,'') AS service_division,
                date, COALESCE(location,'') AS location,
                'event'::text AS type
           FROM ochr_events
          WHERE organization_id = $2
            AND search_vec @@ websearch_to_tsquery('english', $1)
          ORDER BY date DESC LIMIT 5`,
        [q, orgId]
      ),
      searchScope('tasks',
        `SELECT id, title, COALESCE(category,'') AS category,
                COALESCE(priority,'') AS priority, COALESCE(status,'') AS status,
                'task'::text AS type
           FROM ochr_tasks
          WHERE organization_id = $2
            AND search_vec @@ websearch_to_tsquery('english', $1)
          ORDER BY created_at DESC LIMIT 5`,
        [q, orgId]
      ),
      searchScope('staff',
        `SELECT id, name, COALESCE(role,'') AS role,
                COALESCE(status,'') AS status,
                'staff'::text AS type
           FROM ochr_payroll_staff
          WHERE organization_id = $2
            AND search_vec @@ websearch_to_tsquery('english', $1)
          ORDER BY name LIMIT 5`,
        [q, orgId]
      ),
      searchScope('donations',
        `SELECT id, donor_name, amount, COALESCE(category,'') AS category,
                date, 'donation'::text AS type
           FROM ochr_donations
          WHERE organization_id = $2
            AND search_vec @@ websearch_to_tsquery('english', $1)
          ORDER BY date DESC LIMIT 5`,
        [q, orgId]
      ),
      mayReadPlans
        ? searchScope('servicePlans',
          `SELECT id, title, to_char(date, 'YYYY-MM-DD') AS date,
                  'service_plan'::text AS type
             FROM ochr_service_plans
            WHERE organization_id = $2
              AND (title ILIKE $1 ESCAPE '\\' OR $3::boolean)
            ORDER BY (date < CURRENT_DATE),
                     CASE WHEN date >= CURRENT_DATE THEN date END ASC,
                     date DESC, id DESC
            LIMIT 5`,
          [like, orgId, planWord]
        )
        : Promise.resolve([]),
      searchScope('masses',
        `SELECT id, title, to_char(date, 'YYYY-MM-DD') AS date,
                to_char(start_time, 'HH24:MI') AS start_time,
                'mass'::text AS type
           FROM ochr_calendar_events
          WHERE organization_id = $2
            AND lower(btrim(COALESCE(type, ''))) <> 'meeting'
            AND (title ILIKE $1 ESCAPE '\\' OR $3::boolean)
          ORDER BY (date < CURRENT_DATE),
                   CASE WHEN date >= CURRENT_DATE THEN date END ASC,
                   date DESC, id DESC
          LIMIT 5`,
        [like, orgId, massWord]
      ),
      // SP-185: ⌘K "Testwalker" must find Mass intentions by intention text
      // or requester (same ILIKE fields as GET /api/mass-intentions?q=).
      // Never returns stipend. Staff/admin only.
      mayReadIntentions
        ? searchScope('massIntentions',
          `SELECT mi.id, mi.intention AS title,
                  COALESCE(mi.requested_by, '') AS requested_by,
                  to_char(COALESCE(mi.fulfilled_mass_date, mi.mass_date), 'YYYY-MM-DD') AS mass_date,
                  mi.status,
                  'mass_intention'::text AS type
             FROM ochr_mass_intentions mi
             LEFT JOIN ochr_clients c
               ON c.id = mi.requested_by_client_id
              AND c.organization_id = mi.organization_id
            WHERE mi.organization_id = $2
              AND (mi.intention ILIKE $1 ESCAPE '\\'
                   OR COALESCE(mi.requested_by, '') ILIKE $1 ESCAPE '\\'
                   OR COALESCE(c.name, '') ILIKE $1 ESCAPE '\\')
            ORDER BY COALESCE(mi.fulfilled_mass_date, mi.mass_date) DESC NULLS LAST,
                     mi.id DESC
            LIMIT 5`,
          [like, orgId]
        )
        : Promise.resolve([]),
    ])

    // SP-014..022: a Viewer may search Members, plus Masses on the Schedule
    // they are allowed to open. Service plans and Mass intentions stay with
    // staff and admins (SP-185).
    const results = req.user?.role === 'viewer'
      ? [...clients, ...masses]
      : [...clients, ...events, ...tasks, ...staff, ...donations, ...plans, ...masses, ...intentions]
    res.json(results)
  } catch (err) {
    // The query is often a person's name. The log and the Sentry extra
    // get its length, never the text.
    const rawQ = typeof req.query.q === 'string' ? req.query.q : ''
    monitor.error('search.handler', err, { qLength: rawQ.length })
    res.status(500).json({ error: 'Search failed' })
  }
})

export default router
