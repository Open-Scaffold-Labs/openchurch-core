#!/usr/bin/env node
// Synthetic reviewer parish for a throwaway local or CI Postgres.
//
//   DATABASE_URL='postgresql://postgres@127.0.0.1:5433/openchurch_local' \
//   REVIEWER_FIXTURE_EMAIL='reviewer@example.com' \
//   REVIEWER_FIXTURE_PASSWORD='a-long-password-you-invented' \
//   REVIEWER_FIXTURE_ORG_NAME='Synthetic Reviewer Parish' \
//   node server/scripts/seed-reviewer-fixtures.js
//
// Refuses any DATABASE_URL that is not loopback, including a loopback
// authority with a remote libpq ?host= / ?hostaddr=, and any non-loopback
// PGHOST / PGHOSTADDR. Production (NODE_ENV or VERCEL_ENV) is refused.
// There is no remote override. This script does not load dotenv before
// the gate, and it does not read a password from a default.
//
// Credentials are whatever you exported. They are not printed. The child
// check-in stores a hash only; the pickup code is not printed.
//
// See docs/IOS-DEVICE-CHECKLIST.md. This script does not make a build
// TestFlight-ready.

import { assertReviewerFixtureTarget } from '../src/seed/reviewerFixtureGuard.js'

const gate = assertReviewerFixtureTarget(process.env)
if (!gate.ok) {
  console.error(`Reviewer fixture seed refused: ${gate.reason}`)
  process.exit(2)
}

const approvedUrl = process.env.DATABASE_URL
const { default: pool } = await import('../src/db.js')

if (process.env.DATABASE_URL !== approvedUrl || !assertReviewerFixtureTarget(process.env).ok) {
  console.error('Reviewer fixture seed refused: remote_refused')
  await pool.end().catch(() => {})
  process.exit(2)
}

const { seedReviewerFixtures } = await import('../src/seed/reviewerFixtures.js')

let exitCode = 0
let client = null
try {
  // One reserved connection for BEGIN..COMMIT/ROLLBACK (node-postgres
  // transactions require the same checked-out client).
  client = await pool.connect()
  const result = await seedReviewerFixtures(client, process.env)
  const c = result.counts
  console.log(`Created synthetic parish '${result.organizationSlug}' (id ${result.organizationId})`)
  console.log(`Login email: ${result.email}`)
  console.log(`Sunday used for Mass, intention, and check-in: ${result.sunday}`)
  console.log(`Members ${c.members}, register ${c.register}, intentions ${c.intentions}, sacristy rows ${c.sacristy}, check-ins ${c.checkins}, events ${c.events}`)
  if (c.sacristy < 1) {
    console.error('Reviewer fixture seed wrote an intention that the Sacristy List did not return.')
    exitCode = 1
  }
} catch (err) {
  console.error(err.message || err)
  exitCode = 1
} finally {
  if (client) client.release()
  await pool.end().catch(() => {})
}
process.exit(exitCode)
