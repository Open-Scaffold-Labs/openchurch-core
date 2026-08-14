// Local development entry point.
//
// Runs `npm run dev` and `npm start` from server/package.json. For prod
// the Express app deploys as a Vercel serverless function via the root
// api/[...path].js entrypoint — that path imports `app` directly and
// never executes this file.

import 'dotenv/config'
import app from './app.js'
import { runAllMigrations } from './migrations/index.js'
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
  runAllMigrations().catch(err => monitor.error('migrations.boot', err))
})
