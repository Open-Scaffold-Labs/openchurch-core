import pg from 'pg'
import pgArray from 'postgres-array'
import 'dotenv/config'
import { monitor } from './monitoring/index.js'

const { Pool } = pg

// DATE (oid 1082) is a civil day, not an instant. node-postgres otherwise
// builds a JS Date at the process's local midnight, and JSON.stringify
// turns that into an ISO timestamp whose calendar day depends on TZ:
// a stored 2026-09-27 leaves UTC as 2026-09-27T00:00:00.000Z (the previous
// evening in the US) and Pacific/Auckland as 2026-09-26T12:00:00.000Z.
// Postgres already sends the day as text ('YYYY-MM-DD'). Keep that text.
// Timestamps (1114 / 1184) stay instants. to_char(...) is text, not date,
// so existing calendar-day queries are unchanged.
pg.types.setTypeParser(1082, (value) => value)

// date[] (oid 1182) is registered with the default element parser closed
// over, so the 1082 parser above does not reach it. postgres-array is
// the parser pg-types uses: NULL stays null, '{}' is [], and a 2-D
// array stays nested. Each element is the YYYY-MM-DD text Postgres sent.
function dateArrayElement(value) {
  if (value == null) return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value))
  return match ? match[1] : String(value)
}

function parseDateArray(value) {
  if (value == null) return null
  return pgArray.parse(String(value), dateArrayElement)
}
pg.types.setTypeParser(1182, parseDateArray)

// Single Postgres pool, shared across the whole server.
//
// For Supabase, prefer the POOLER connection string (port 6543 in
// transaction mode) over the direct connection string (port 5432). The
// pooler is PgBouncer in front of Postgres and is the only connection
// mode safe for serverless — direct connections from Vercel functions
// blow through Postgres' max_connections in seconds under any real load.
//
// The pooler URL from Supabase looks like:
//   postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
//
// Local dev against a non-Supabase Postgres keeps working — we just
// turn SSL off when there's no sslmode= in the connection string or
// the host is localhost.

const url = process.env.DATABASE_URL || ''

function sslConfig() {
  if (!url) return false
  // Local dev against localhost: no SSL.
  if (/^postgres(ql)?:\/\/[^/]*@(localhost|127\.0\.0\.1)/i.test(url)) return false
  // Supabase, Render, Heroku, etc. all use self-signed or intermediate
  // certs — rejectUnauthorized: false is the conventional pragma.
  return { rejectUnauthorized: false }
}

const pool = new Pool({
  connectionString: url,
  ssl: sslConfig(),
  // Serverless-friendly defaults: keep the pool small and let the
  // pooler handle connection reuse. On a long-running dev server these
  // are effectively unbounded because we never hit the ceiling.
  max: parseInt(process.env.PG_POOL_MAX || '5', 10),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
})

// Surface any connection-level errors instead of crashing the process
// (a disconnected idle client in PgBouncer is the most common cause).
pool.on('error', (err) => {
  monitor.error('db.pool', err)
})

export default pool
