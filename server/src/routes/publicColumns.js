// The columns two resources are allowed to leave the server with.
//
// These lived inside tasks.js and events.js, which was fine until a query in
// ONE of those files had to project the OTHER's row: GET /api/events/:id/tasks
// returns tasks, GET /api/tasks/:id/events returns events. Importing across
// the two routers would have made a cycle, and copying the lists into both
// would have recreated the exact failure this whole line of work is about —
// two declarations of the same contract, drifting apart silently.
//
// So the contract lives in one place and both routers read it. This is
// deliberately NOT a general response layer; it holds the two lists that
// genuinely have more than one reader. See the Pass 6 report for the wider
// recommendation.
//
// `prefixed('t')` yields "t.id, t.organization_id, …" for joined queries,
// where `SELECT t.*` was shipping the tsvector.

const contract = (columns) => ({
  columns,
  list: columns.join(', '),
  prefixed: (alias) => columns.map(c => `${alias}.${c}`).join(', '),
})

export const TASK_COLUMNS = contract([
  'id', 'organization_id', 'title', 'description', 'category', 'assigned_to',
  'assigned_member_id', 'priority', 'status', 'recurring_freq', 'checklist',
  'due_date', 'created_at', 'completed_at',
])

export const EVENT_COLUMNS = contract([
  'id', 'organization_id', 'title', 'service_division', 'date', 'time',
  'location', 'liturgical_season', 'liturgical_color', 'feast_name',
  'language', 'is_public', 'created_at',
])
