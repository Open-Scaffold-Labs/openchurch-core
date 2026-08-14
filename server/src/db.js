import pg from 'pg'
import 'dotenv/config'
import { monitor } from './monitoring/index.js'

const { Pool } = pg

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
