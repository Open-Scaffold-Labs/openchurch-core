// Explicit App Review tenant seed (OC-READY-01-010).
//
//   node server/scripts/seed-app-review-tenant.js
//
// Writes a throwaway review org + user from environment variables.
// Never hardcodes a password. Never runs against production
// (NODE_ENV=production is refused). A remote DATABASE_URL also needs
// APP_REVIEW_ALLOW_REMOTE=1.
//
// Required:
//   SEED_APP_REVIEW_TENANT=1
//   APP_REVIEW_EMAIL=...
//   APP_REVIEW_PASSWORD=...
//   APP_REVIEW_ORG_NAME=...
//   DATABASE_URL=...
//
// See docs/APP-REVIEW-TENANT.md. Do not put these values in the client
// bundle or in App Store Connect except the Review Notes field.

import 'dotenv/config'
import pool from '../src/db.js'
import { seedAppReviewTenant } from '../src/seed/appReviewTenant.js'

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — cannot seed an App Review tenant.')
  process.exit(1)
}

let exitCode = 0
try {
  const result = await seedAppReviewTenant(pool)
  if (result.seeded) {
    console.log(`Created App Review org '${result.organizationSlug}' (id ${result.organizationId}) for ${result.email}`)
  } else if (result.reason === 'already_exists') {
    console.log(`App Review tenant already present: '${result.organizationSlug}' (${result.email})`)
  } else {
    console.log(`App Review tenant seed skipped: ${result.reason}`)
  }
} catch (err) {
  console.error(err.message || err)
  exitCode = 1
} finally {
  await pool.end().catch(() => {})
}
process.exit(exitCode)
