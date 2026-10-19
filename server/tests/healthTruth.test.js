// Health truth — /api/health must not say "ok" about a build whose schema
// is behind its code.
//
// The payload already reported both `migration` (what the ledger says is
// applied) and `migration_expected` (what this build ships). But `status`
// and the HTTP code were derived from the database ping alone, so a schema
// at 098 under code at 099 answered 200 {status:'ok'} while three routes
// 500'd on the missing table (reproduced 8 Sep). prod-health.yml reads
// exactly `status` and `db`, and a monitor that only knows what the
// payload's summary field tells it was being told the wrong thing.
//
// The disagreement is produced for real here: the head ledger row is
// removed, the endpoint is probed, the row is put back. The migration
// runner's advisory lock is held for the duration so a sibling test file
// running migrateOnce() in parallel waits rather than re-applying the head
// migration into the gap.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import pool from '../src/db.js'
import { bindServer, closeServer, migrateOnce } from './support/harness.js'
import { EXPECTED_MIGRATION } from '../src/migrations/names.js'

// Same key as migrations/index.js. Not exported from there on purpose — a
// test holding the runner's lock is a test-only need, and this file is the
// one place that needs it.
const MIGRATION_LOCK_KEY = 727274

let server

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

const health = () => request(server).get('/api/health')

describe('H1 — /api/health is degraded when the schema is behind the code', () => {
  it('fully migrated → 200 ok, and the two migration fields agree', async () => {
    const res = await health()
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.db).toBe('ok')
    expect(res.body.migration).toBe(EXPECTED_MIGRATION)
    expect(res.body.migration_expected).toBe(EXPECTED_MIGRATION)
    expect(res.body.schema).toBe('ok')
  })

  it('head migration missing from the ledger → 503 degraded, db still ok, both migration fields present', async () => {
    const client = await pool.connect()
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
      await client.query('DELETE FROM ochr_schema_migrations WHERE name = $1', [EXPECTED_MIGRATION])
      try {
        const res = await health()
        expect(res.status).toBe(503)
        expect(res.body.status).toBe('degraded')
        // The database answered — it is the SCHEMA that is wrong, and the
        // payload says which, so an operator does not go looking at the
        // wrong thing.
        expect(res.body.db).toBe('ok')
        expect(res.body.schema).toBe('behind')
        expect(res.body.migration).not.toBe(EXPECTED_MIGRATION)
        expect(res.body.migration).toMatch(/^\d{3}-/)
        expect(res.body.migration_expected).toBe(EXPECTED_MIGRATION)
        // Every other field the monitors and rollback tooling read is still
        // there — degraded is a verdict added to the payload, not a
        // different payload.
        for (const k of ['payments_provider', 'payments_configured', 'payments_capable', 'payments_webhook_ready',
          'payments_safe', 'commit', 'commit_short', 'environment']) {
          expect(res.body, k).toHaveProperty(k)
        }
      } finally {
        await client.query(
          'INSERT INTO ochr_schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [EXPECTED_MIGRATION])
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      }
    } finally {
      client.release()
    }

    // Restored → ok again. The verdict follows the ledger, not a cache.
    const res = await health()
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.schema).toBe('ok')
    expect(res.body.migration).toBe(EXPECTED_MIGRATION)
  })
})
