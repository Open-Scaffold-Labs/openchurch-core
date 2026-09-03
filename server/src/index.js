// Local development entry point.
//
// Runs `npm run dev` and `npm start` from server/package.json. For prod
// the Express app deploys as a Vercel serverless function via the root
// api/[...path].js entrypoint — that path imports `app` directly and
// never executes this file.

import 'dotenv/config'
import app from './app.js'
import { runAllMigrations } from './migrations/index.js'
import { recordRelease, releaseInfo } from './release/log.js'
import { monitor } from './monitoring/index.js'

process.on('uncaughtException', (err) => {
  monitor.error('process.uncaughtException', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  monitor.error('process.unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)))
  process.exit(1)
})

const PORT = process.env.PORT || 3034
console.log(`Starting server on port ${PORT}, DB: ${process.env.DATABASE_URL ? 'set' : 'NOT SET'}`)

app.listen(PORT, () => {
  console.log(`OpenChurch server running on port ${PORT}`)
  // In local dev we run migrations on boot for convenience. In prod
  // (Vercel) migrations run from migrate-cli.js (via GitHub Action or
  // manually) so serverless cold-starts don't keep hammering the DB.
  // Fail closed. A migration that throws here leaves the schema in an unknown
  // state, and a server that keeps answering requests over an unknown schema
  // turns a loud startup failure into a quiet data problem discovered later.
  // This boot path is dev-only (prod migrates via migrate-cli.js in CI), and
  // in dev the database is often the production one — so "keep serving anyway"
  // is the worst available default. (Restored 2026-08-22: a sweep rebuilt this
  // file from a copy predating 68e59a2 and reinstated the swallow.)
  runAllMigrations()
    .catch(err => {
      monitor.error('migrations.boot', err)
      console.error('\nFATAL: migrations failed — refusing to serve on an unverified schema.')
      process.exit(1)
    })
    // Only AFTER the migrations, so the table is certainly there. This is
    // the long-lived-server path; serverless never runs migrations and
    // records itself from the health handler instead. A failure to record a
    // release is telemetry, not schema — it must not take the server down.
    .then(() => recordRelease(releaseInfo()))
    .catch(err => monitor.error('release.record', err))
})
