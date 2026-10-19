// DEMO-L1-08 — fail-closed rehearsal identity. Mutate the loopback
// allow-list or treat a missing URL as safe and these tests go red.
//
//   node --test scripts/demo-rehearsal.test.mjs

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LOOPBACK, allowLocalDb, classifyDatabaseUrl, parseArgs } from './demo-rehearsal.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'demo-rehearsal.mjs')

describe('classifyDatabaseUrl', () => {
  it('missing and blank are unsafe', () => {
    assert.equal(classifyDatabaseUrl(undefined).kind, 'missing')
    assert.equal(classifyDatabaseUrl('').kind, 'missing')
    assert.equal(classifyDatabaseUrl('   ').kind, 'missing')
  })

  it('loopback hosts are local', () => {
    assert.equal(classifyDatabaseUrl('postgres://postgres@localhost:5433/openchurch_local').kind, 'local')
    assert.equal(classifyDatabaseUrl('postgres://postgres@127.0.0.1:5432/x').kind, 'local')
    assert.equal(classifyDatabaseUrl('postgres://postgres@[::1]:5432/x').kind, 'local')
  })

  it('remote and unparseable hosts are not local', () => {
    assert.equal(classifyDatabaseUrl('postgres://postgres@db.example.supabase.co:5432/postgres').kind, 'remote')
    assert.equal(classifyDatabaseUrl('not-a-url').kind, 'invalid')
  })

  it('refuses a loopback authority with a remote ?host= or ?hostaddr=', () => {
    const qHost = classifyDatabaseUrl('postgres://postgres@localhost:5432/openchurch_local?host=db.prod.example')
    assert.equal(qHost.kind, 'remote')
    assert.equal(qHost.hostname, 'db.prod.example')
    const qAddr = classifyDatabaseUrl('postgres://postgres@127.0.0.1:5432/x?hostaddr=8.8.8.8')
    assert.equal(qAddr.kind, 'remote')
    assert.equal(qAddr.hostname, '8.8.8.8')
    const lastWins = classifyDatabaseUrl('postgres://postgres@localhost/db?host=localhost&host=db.prod.example')
    assert.equal(lastWins.kind, 'remote')
    assert.equal(lastWins.hostname, 'db.prod.example')
    const lastAddr = classifyDatabaseUrl('postgres://postgres@localhost/db?hostaddr=127.0.0.1&hostaddr=8.8.8.8')
    assert.equal(lastAddr.kind, 'remote')
    assert.equal(lastAddr.hostname, '8.8.8.8')
  })

  it('pins the loopback allow-list — adding an untested host goes red', () => {
    assert.deepEqual([...LOOPBACK].sort(), ['127.0.0.1', '::1', '[::1]', 'localhost'].sort())
  })
})

describe('allowLocalDb', () => {
  const localUrl = 'postgres://postgres@localhost:5433/openchurch_local'

  it('refuses when the rehearsal flag is missing or wrong', () => {
    assert.equal(allowLocalDb({ rehearsal: undefined, databaseUrl: localUrl }).ok, false)
    assert.equal(allowLocalDb({ rehearsal: 'yes', databaseUrl: localUrl }).ok, false)
    assert.equal(allowLocalDb({ rehearsal: 'LOCAL', databaseUrl: localUrl }).ok, false)
  })

  it('refuses a missing or remote DATABASE_URL even with the flag', () => {
    assert.equal(allowLocalDb({ rehearsal: 'local', databaseUrl: '' }).ok, false)
    assert.equal(allowLocalDb({
      rehearsal: 'local',
      databaseUrl: 'postgres://postgres@db.prod.example:5432/postgres',
    }).ok, false)
    assert.equal(allowLocalDb({
      rehearsal: 'local',
      databaseUrl: 'postgres://postgres@localhost:5432/openchurch_local?host=db.prod.example',
    }).ok, false)
  })

  it('allows only local + loopback together', () => {
    const ok = allowLocalDb({ rehearsal: 'local', databaseUrl: localUrl })
    assert.equal(ok.ok, true)
    assert.match(ok.reason, /loopback localhost/)
  })
})

describe('parseArgs', () => {
  it('defaults to proof with no flags', () => {
    const opts = parseArgs(['node', 'demo-rehearsal.mjs'])
    assert.equal(opts.proof, true)
    assert.equal(opts.localDb, false)
  })

  it('does not treat --local-db alone as an implicit proof run', () => {
    const opts = parseArgs(['node', 'demo-rehearsal.mjs', '--local-db'])
    assert.equal(opts.localDb, true)
    assert.equal(opts.proof, false)
  })
})

describe('demo-rehearsal --local-db CLI', () => {
  it('exits 2 when environment identity is missing', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--local-db'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, OCHR_REHEARSAL: '', DATABASE_URL: '' },
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /OCHR_REHEARSAL must be exactly "local"/)
  })

  it('exits 2 when a later repeated ?host= is remote', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--local-db'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        OCHR_REHEARSAL: 'local',
        DATABASE_URL: 'postgres://postgres@localhost:5433/openchurch_local?host=localhost&host=db.prod.example',
      },
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /not loopback/)
  })

  it('exits 2 when a loopback URL hides a remote ?host=', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--local-db'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        OCHR_REHEARSAL: 'local',
        DATABASE_URL: 'postgres://postgres@localhost:5433/openchurch_local?host=db.prod.example',
      },
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /not loopback/)
  })

  it('exits 2 when DATABASE_URL is remote', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--local-db'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        OCHR_REHEARSAL: 'local',
        DATABASE_URL: 'postgres://postgres@db.example.supabase.co:5432/postgres',
      },
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /not loopback/)
  })

  it('exits 0 on loopback without seeding', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--local-db'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        OCHR_REHEARSAL: 'local',
        DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/openchurch_local',
      },
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /does not seed/)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /seedStBrigids|npm run migrate/)
  })
})
