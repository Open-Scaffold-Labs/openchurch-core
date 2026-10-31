#!/usr/bin/env node
// Synthetic iOS acceptance-pack parish for a throwaway local Postgres.
//
//   DATABASE_URL='postgresql://postgres@127.0.0.1:5433/openchurch_acceptance_pack' \
//   ACCEPTANCE_PACK_EMAIL='reviewer@example.com' \
//   ACCEPTANCE_PACK_PASSWORD='a-long-password-you-invented' \
//   ACCEPTANCE_PACK_ORG_NAME='Synthetic Acceptance Parish' \
//   node server/scripts/seed-acceptance-pack.js
//
// Dry-run by default (prints the plan, writes nothing). To apply:
//
//   ACCEPTANCE_PACK_APPLY=1 node server/scripts/seed-acceptance-pack.js
//
// Refuses any DATABASE_URL that is not loopback, including a loopback
// authority with a remote libpq ?host= / ?hostaddr=, and any non-loopback
// PGHOST / PGHOSTADDR. Production (NODE_ENV or VERCEL_ENV) is refused.
// Also refuses ordinary local DBs (openchurch_local, …): the database name
// must match openchurch_acceptance_* and carry the prepare-script marker
// before any write. There is no remote override and no production override.
// This script does not load dotenv before the gate, and it does not read a
// password from a default. Credentials are whatever you exported; they are
// never printed.
//
// See docs/ios/ACCEPTANCE-PACK.md. This script does not make a build
// TestFlight-ready and does not touch a real database.

import {
  assertAcceptancePackTarget,
  resolveAcceptancePack,
  acceptancePackPlan,
} from '../src/seed/acceptancePackGuard.js'

const gate = assertAcceptancePackTarget(process.env)
if (!gate.ok) {
  console.error(`Acceptance pack seed refused: ${gate.reason}`)
  process.exit(2)
}

const resolved = resolveAcceptancePack(process.env)
if (!resolved.ok) {
  console.error(`Acceptance pack seed refused: ${resolved.reason}`)
  process.exit(2)
}

if (resolved.dryRun) {
  const plan = acceptancePackPlan(resolved.config)
  console.log('Acceptance pack DRY-RUN (nothing written). Set ACCEPTANCE_PACK_APPLY=1 to write.')
  console.log(`Would create parish '${resolved.config.orgSlug}' with viewer login ${resolved.config.email}`)
  console.log(`Plan: members ${plan.members} (${plan.preferredLanguages.join('/')}),`
    + ` register ${plan.register}, intentions ${plan.intentions},`
    + ` events ${plan.events}, bulletin ${plan.bulletins}, role ${plan.role}`)
  process.exit(0)
}

const approvedUrl = process.env.DATABASE_URL
const { default: pool } = await import('../src/db.js')

if (process.env.DATABASE_URL !== approvedUrl || !assertAcceptancePackTarget(process.env).ok) {
  console.error('Acceptance pack seed refused: remote_refused')
  await pool.end().catch(() => {})
  process.exit(2)
}

const { seedAcceptancePack } = await import('../src/seed/acceptancePack.js')

let exitCode = 0
let client = null
try {
  client = await pool.connect()
  const result = await seedAcceptancePack(client, process.env)
  if (result.dryRun) {
    console.log('Acceptance pack DRY-RUN (nothing written).')
  } else {
    const c = result.counts
    console.log(`Created synthetic parish '${result.organizationSlug}' (id ${result.organizationId})`)
    console.log(`Login email: ${result.email} (role ${result.role})`)
    console.log(`Sunday used for Mass, intention, bulletin, and check-in: ${result.sunday}`)
    console.log(`Members ${c.members}, languages ${JSON.stringify(c.preferredLanguages)},`
      + ` register ${c.register}, intentions ${c.intentions}, sacristy rows ${c.sacristy},`
      + ` check-ins ${c.checkins}, events ${c.events}, bulletins ${c.bulletins}`)
    if (c.sacristy < 1) {
      console.error('Acceptance pack seed wrote an intention that the Sacristy List did not return.')
      exitCode = 1
    }
  }
} catch (err) {
  console.error(err.message || err)
  exitCode = 1
} finally {
  if (client) client.release()
  await pool.end().catch(() => {})
}
process.exit(exitCode)
