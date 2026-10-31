#!/usr/bin/env node
// Mark a disposable local Postgres database as an acceptance-pack target.
//
//   createdb -h 127.0.0.1 -p 5433 -U postgres openchurch_acceptance_pack
//   DATABASE_URL='postgresql://postgres@127.0.0.1:5433/openchurch_acceptance_pack' \
//     node server/scripts/prepare-acceptance-pack-db.js
//   # then migrate against that URL, then seed with ACCEPTANCE_PACK_APPLY=1
//
// Refuses ordinary local DBs (openchurch_local, …), remote hosts, and
// production. Creates ochr_acceptance_pack_marker with the v1 token.
// See docs/ios/ACCEPTANCE-PACK.md.

import {
  assertAcceptancePackTarget,
  acceptancePackMarkerDdl,
  ACCEPTANCE_PACK_MARKER_TOKEN,
} from '../src/seed/acceptancePackGuard.js'

const gate = assertAcceptancePackTarget(process.env)
if (!gate.ok) {
  console.error(`Acceptance pack prepare refused: ${gate.reason}`)
  process.exit(2)
}

const approvedUrl = process.env.DATABASE_URL
const { default: pool } = await import('../src/db.js')

if (process.env.DATABASE_URL !== approvedUrl || !assertAcceptancePackTarget(process.env).ok) {
  console.error('Acceptance pack prepare refused: remote_refused')
  await pool.end().catch(() => {})
  process.exit(2)
}

let exitCode = 0
let client = null
try {
  client = await pool.connect()
  await client.query(acceptancePackMarkerDdl())
  const { rows } = await client.query(
    'SELECT token FROM ochr_acceptance_pack_marker WHERE token = $1',
    [ACCEPTANCE_PACK_MARKER_TOKEN],
  )
  if (!rows.length) {
    console.error('Acceptance pack prepare refused: marker_missing after DDL')
    exitCode = 1
  } else {
    console.log(`Marked disposable database '${gate.databaseName}' for acceptance-pack writes.`)
    console.log(`Marker token: ${ACCEPTANCE_PACK_MARKER_TOKEN}`)
  }
} catch (err) {
  console.error(err.message || err)
  exitCode = 1
} finally {
  if (client) client.release()
  await pool.end().catch(() => {})
}
process.exit(exitCode)
