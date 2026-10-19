import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

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

    const [clients, events, tasks, staff, donations] = await Promise.all([
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
    ])

    // SP-014..022: a Viewer may search Members only (Help role table).
    const results = req.user?.role === 'viewer'
      ? [...clients]
      : [...clients, ...events, ...tasks, ...staff, ...donations]
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
