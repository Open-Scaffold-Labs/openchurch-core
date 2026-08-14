// Runs database migrations once and exits.
//
// Use this anywhere you need to apply schema changes without booting
// the HTTP server:
//
//   node server/src/migrate-cli.js           # from repo root
//   npm run migrate                          # root package.json alias
//
// In production (Vercel) we don't run migrations on every cold-start
// the way local dev does — this CLI is the intended entry point,
// typically invoked by a GitHub Action after a push to main or run
// manually when pulling a branch that adds schema changes.
//
// DATABASE_URL must be set in the environment (Vercel env, a local
// .env, or the shell). The script exits non-zero on failure so CI
// can fail the deploy if the migration doesn't apply cleanly.

import 'dotenv/config'
import { runAllMigrations } from './migrations/index.js'

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — cannot run migrations.')
    process.exit(1)
  }
  console.log('Running migrations against', redact(process.env.DATABASE_URL))
  await runAllMigrations()
  console.log('All migrations complete.')
}

// Strip the password from a postgres URL for logging.
function redact(url) {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '[unparseable url]'
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  },
)
