// Shared fixtures for the test files.
//
// smoke.test.js grew to 15,700 lines because every new area was appended to
// the one file that already had a bound listener and a run id. Splitting it
// is not about line count: a 15,000-line file cannot be read, and a test
// nobody can find is a test nobody maintains.
//
// The split is deliberately partial. Most of the suite shares module-level
// fixtures — one admin token that has to STAY admin while the role tests run
// underneath it, two orgs whose isolation is checked against each other —
// and pulling those apart mechanically would quietly weaken the guarantees
// they exist to prove. What moves out is only what already stands alone:
// blocks that sign up their own parish and share nothing. This module is
// what they share instead.

import { runAllMigrations } from '../../src/migrations/index.js'
import app from '../../src/app.js'

// Unique per FILE, not per suite. Two files running in parallel against the
// same dev database must not collide on an email address.
export const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

// One bound listener per file. `request(app)` looks stateless but binds a
// fresh ephemeral port for every call — at hundreds of call sites the kernel
// intermittently resets one of those short-lived sockets, and the symptom is
// a random test dying at ~3ms with "socket hang up", which reads like a
// tenant-isolation failure and is pure transport churn.
export async function bindServer() {
  const server = app.listen(0)
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  return server
}

export async function closeServer(server) {
  if (server) await new Promise(resolve => server.close(resolve))
}

// Migrations run once per process. Vitest isolates each test file in its own
// worker, so without the guard every file would re-run the whole migration
// set — and files running in parallel would race each other doing it.
let migrated = null
export function migrateOnce() {
  migrated ??= runAllMigrations()
  return migrated
}

export { app }
