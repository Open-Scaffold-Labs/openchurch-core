// St. Brigid's week anchor is a civil Sunday in the demo org's timezone.
//
// seedStBrigids used to subtract Date#getDay and store
// toISOString().slice(0, 10). Saturday 23:00 America/Los_Angeles is
// Sunday morning UTC, and that anchor was stored as Monday
// 2026-09-21. The week that contains that Saturday starts on
// 2026-09-20 in the parish zone.
//
// Reverting demoSundayAnchor to getDay + setDate + toISOString stores
// 2026-09-21 when the process zone is America/Los_Angeles, and
// 2026-09-27 when the process zone is UTC. Neither is 2026-09-20.

import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyDatabaseUrl } from '../../scripts/lib/db-target-guard.mjs'

const dbTarget = classifyDatabaseUrl(process.env.DATABASE_URL)
if (dbTarget.kind !== 'local') {
  throw new Error(
    `stBrigidsSunday.test.js refuses to run (database target kind=${dbTarget.kind}). Export a loopback DATABASE_URL.`
  )
}

const { default: pool } = await import('../src/db.js')
const { migrateOnce, RUN_ID } = await import('./support/harness.js')
const { PARISH } = await import('../src/demo/stBrigids.js')
const { invokedAsCli, seedStBrigidDemo } = await import('../src/demo/seedStBrigids.js')

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const SAT_2300 = new Date('2026-09-26T23:00:00-07:00')
const CHORAL = [
  '2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04',
]

const orgIds = []

beforeAll(async () => {
  await migrateOnce()
}, 60_000)

afterAll(async () => {
  if (orgIds.length) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = ANY($1::int[])', [orgIds])
  }
  await pool.end()
})

describe('St. Brigid demo Sundays follow the org timezone', () => {
  it('Saturday 23:00 Pacific anchors the week on Sunday', async () => {
    const slug = `brigid-sun-${RUN_ID}`
    const { rows } = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, tradition, timezone)
       VALUES ($1, $2, 'episcopal', 'America/Los_Angeles')
       RETURNING id`,
      [PARISH.name, slug]
    )
    const orgId = rows[0].id
    orgIds.push(orgId)

    const client = await pool.connect()
    try {
      await seedStBrigidDemo(client, orgId, { now: SAT_2300 })
    } finally {
      client.release()
    }

    const { rows: choral } = await pool.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date
         FROM ochr_calendar_events
        WHERE organization_id = $1 AND title = 'Choral Eucharist, Rite II'
        ORDER BY date`,
      [orgId]
    )
    const dates = choral.map(r => r.date)
    expect(dates).toEqual(CHORAL)
    for (const iso of dates) {
      expect(new Date(`${iso}T00:00:00Z`).getUTCDay(), iso).toBe(0)
    }
  }, 60_000)

  it('does not treat a missing argv[1] as the CLI entry', () => {
    const saved = process.argv[1]
    delete process.argv[1]
    try {
      expect(invokedAsCli()).toBe(false)
    } finally {
      process.argv[1] = saved
    }
  })

  // Module load calls invokedAsCli(). realpathSync throws ENOENT for a
  // path that is not there, and for '-' (node - < script), so the import
  // dies before main(). Both must be "not the CLI", not an exception.
  function expectNotCli(entry) {
    const saved = process.argv[1]
    process.argv[1] = entry
    try {
      expect(() => invokedAsCli()).not.toThrow()
      expect(invokedAsCli()).toBe(false)
    } finally {
      process.argv[1] = saved
    }
  }

  it('a nonexistent argv[1] is not the CLI entry', () => {
    expectNotCli('/nonexistent/zz.js')
  })

  it("a stdin dash argv[1] is not the CLI entry", () => {
    expectNotCli('-')
  })

  it('a symlink entry still runs the seeder', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'brigid-cli-'))
    const link = path.join(dir, 'seed-link.js')
    const script = fileURLToPath(new URL('../src/demo/seedStBrigids.js', import.meta.url))
    symlinkSync(script, link)
    try {
      const run = spawnSync(process.execPath, [link, '--org', '999999999'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL,
        },
        encoding: 'utf8',
      })
      const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
      expect(run.status, output).not.toBe(0)
      expect(output).toMatch(/999999999 does not exist/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
