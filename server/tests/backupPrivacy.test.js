// Backups are stored, never emailed (#214).
//
// Before: the weekly digest attached every organization's full gzipped
// export to one email to SUPER_ADMIN_EMAIL whenever RESEND_API_KEY was set
// — with or without storage. Production already has SUPER_ADMIN_EMAIL, so
// the one key password-reset email needs would have started it.
//
// Pinned here, against the real digest and a real (file) store:
//   - no backup email carries an attachment, ever;
//   - no backup email carries a parish name, slug, member or export body;
//   - with no storage nothing is built and the heartbeat says NOT RUNNING;
//   - stored objects are tenant-separated (orgs/<id>/<date>.json.gz) and
//     still restore: the stored bytes gunzip to a valid export.
//
// Demo data only: one synthetic parish with a distinctive member.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import {
  runWeeklyBackupDigest, composeBackupHeartbeat, backupKeyFor,
} from '../src/services/backupDigest.js'

const ENV = ['RESEND_API_KEY', 'SUPER_ADMIN_EMAIL', 'EMAIL_FROM', 'BACKUP_STORAGE', 'BACKUP_DIR',
  'BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_REGION', 'BACKUP_S3_KEY_ID', 'BACKUP_S3_SECRET']

let server
let saved
const realFetch = global.fetch
const parish = {
  organizationName: `Backup Privacy Parish ${RUN_ID}`,
  name: 'Backup Secretary',
  email: `bkp_priv_${RUN_ID}@example.com`,
  password: 'bkp-priv-pw-1',
}
const member = { name: `Distinctive Parishioner ${RUN_ID}`, email: `distinct_${RUN_ID}@example.com` }
let orgId, slug

// Every Resend call the digest makes, captured instead of sent.
let sent
function captureResend() {
  sent = []
  global.fetch = async (url, init) => {
    if (String(url).includes('resend')) {
      sent.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ id: 're_test' }) }
    }
    return realFetch(url, init)
  }
}

beforeAll(async () => {
  saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]))
  await migrateOnce()
  server = await bindServer()
  const res = await createOrg(server, parish, '10.214.1.1')
  expect(res.status).toBe(201)
  orgId = res.body.user.organization.id
  slug = res.body.user.organization.slug
  const c = await request(server).post('/api/clients')
    .set('Authorization', `Bearer ${res.body.token}`)
    .send({ name: member.name, email: member.email })
  expect(c.status).toBe(201)
}, 60_000)

afterAll(async () => {
  global.fetch = realFetch
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server)
})

function clearEnv() { for (const k of ENV) delete process.env[k] }

async function gzipCount(dir) {
  let n = 0
  let ids
  try { ids = await readdir(join(dir, 'orgs')) } catch { return 0 }
  for (const id of ids) {
    let files = []
    try { files = await readdir(join(dir, 'orgs', id)) } catch { continue }
    n += files.filter(f => f.endsWith('.json.gz')).length
  }
  return n
}

function refuseResend() {
  sent = []
  global.fetch = async (url, init) => {
    if (String(url).includes('resend')) {
      sent.push(JSON.parse(init.body))
      return { ok: false, status: 500, text: async () => 'upstream down' }
    }
    return realFetch(url, init)
  }
}

function assertZeroPii(msg) {
  expect(msg, 'backup email must not attach anything').not.toHaveProperty('attachments')
  const body = JSON.stringify(msg)
  for (const needle of [parish.organizationName, slug, member.name, member.email, 'openchurch-export', '"tables"']) {
    if (needle) expect(body, `backup email leaks ${needle}`).not.toContain(needle)
  }
}

describe('backup email carries no parish data', () => {
  it('storage + live mail: objects stored per tenant, heartbeat has no attachment and no PII', async () => {
    clearEnv()
    const dir = await mkdtemp(join(tmpdir(), 'ochr-bkp-priv-'))
    process.env.BACKUP_STORAGE = 'file'
    process.env.BACKUP_DIR = dir
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.SUPER_ADMIN_EMAIL = `founder_${RUN_ID}@example.com`
    captureResend()

    const res = await runWeeklyBackupDigest()
    expect(res.skipped).toBeUndefined()
    expect(res.attached).toBe(0)
    expect(res.stored).toBeGreaterThan(0)
    expect(res.notified).toBe(true)

    expect(sent.length).toBe(1)
    assertZeroPii(sent[0])
    expect(sent[0].text).toMatch(/contains no parish data/)

    // Tenant-separated key, by id. Restore capability: the stored bytes are
    // the same gzipped export a restore reads, and they contain our parish.
    const stamp = new Date().toISOString().slice(0, 10)
    const key = backupKeyFor(orgId, stamp)
    expect(key).toBe(`orgs/${orgId}/${stamp}.json.gz`)
    const dump = JSON.parse(gunzipSync(await readFile(join(dir, key))).toString('utf8'))
    expect(dump.format).toBe('openchurch-export')
    expect(JSON.stringify(dump)).toContain(member.email)
    // and nothing of any other tenant sits under this parish's prefix
    expect(await readdir(join(dir, 'orgs', String(orgId)))).toEqual([`${stamp}.json.gz`])
  })

  it('no storage + live mail: nothing is built, heartbeat says NOT RUNNING, no PII', async () => {
    clearEnv()
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.SUPER_ADMIN_EMAIL = `founder_${RUN_ID}@example.com`
    captureResend()

    const res = await runWeeklyBackupDigest()
    expect(res.skipped).toMatch(/no backup storage/i)
    expect(res).not.toHaveProperty('stored')
    expect(sent.length).toBe(1)
    expect(sent[0].subject).toMatch(/NOT RUNNING/)
    assertZeroPii(sent[0])
  })

  it('no storage + no mail: skipped, nothing sent', async () => {
    clearEnv()
    captureResend()
    const res = await runWeeklyBackupDigest()
    expect(res.skipped).toMatch(/no backup storage/i)
    expect(res.notified).toBe(false)
    expect(sent.length).toBe(0)
  })

  it('stores each object before the first email is sent', async () => {
    clearEnv()
    const dir = await mkdtemp(join(tmpdir(), 'ochr-bkp-order-'))
    process.env.BACKUP_STORAGE = 'file'
    process.env.BACKUP_DIR = dir
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.SUPER_ADMIN_EMAIL = `founder_${RUN_ID}@example.com`
    const stamp = new Date().toISOString().slice(0, 10)
    sent = []
    const atSend = { files: null, orgBytes: 0 }
    global.fetch = async (url, init) => {
      if (String(url).includes('resend')) {
        if (atSend.files === null) {
          atSend.files = await gzipCount(dir)
          try {
            atSend.orgBytes = (await stat(join(dir, backupKeyFor(orgId, stamp)))).size
          } catch { atSend.orgBytes = 0 }
        }
        sent.push(JSON.parse(init.body))
        return { ok: true, status: 200, json: async () => ({ id: 're_test' }) }
      }
      return realFetch(url, init)
    }

    const res = await runWeeklyBackupDigest()
    expect(res.stored).toBeGreaterThan(0)
    expect(atSend.orgBytes).toBeGreaterThan(0)
    expect(atSend.files).toBe(res.stored)
    expect(sent.length).toBe(1)
    expect(sent[0]).not.toHaveProperty('attachments')
    expect(sent[0].subject).toContain(`${res.stored}/${res.orgs} stored`)
    assertZeroPii(sent[0])
  })

  it('a Resend failure with no storage is not recorded as sent', async () => {
    clearEnv()
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.SUPER_ADMIN_EMAIL = `founder_${RUN_ID}@example.com`
    refuseResend()
    const res = await runWeeklyBackupDigest()
    expect(res.skipped).toMatch(/no backup storage/i)
    expect(res.notified).toBe(false)
    expect(res.email).toBe('heartbeat send failed')
    expect(JSON.stringify(res)).not.toContain('heartbeat sent')
    expect(res.notify_error).toMatch(/Resend send failed \(500\)/)
    expect(sent.length).toBe(1)
    assertZeroPii(sent[0])
  })
})

// ── Hard privacy acceptance: every kind of parish record, both paths ──────
//
// The parish above is seeded with one of each record kind the export
// carries. A backup notification may contain run status, date/time,
// storage kind, counts and NUMERIC organization ids — nothing below.
describe('backup notification privacy acceptance', () => {
  const seed = {
    phone: `555-0${String(Date.now()).slice(-3)}`,
    minister: `Fr Sacramental ${RUN_ID}`,
    place: `Chapel of Evidence ${RUN_ID}`,
    donor: `Donor Person ${RUN_ID}`,
    amount: '4321.87',
    giftNote: `Gift note ${RUN_ID}`,
    event: `Vigil Service ${RUN_ID}`,
    child: `Checkin Child ${RUN_ID}`,
    guardian: `Guardian Adult ${RUN_ID}`,
  }

  beforeAll(async () => {
    const tok = (await request(server).post('/api/auth/login')
      .send({ email: parish.email, password: parish.password })).body.token
    const m = await request(server).post('/api/clients').set('Authorization', `Bearer ${tok}`)
      .send({ name: `Phone Holder ${RUN_ID}`, email: `phone_${RUN_ID}@example.com`, phone: seed.phone })
    expect(m.status).toBe(201)
    const sac = await request(server).post('/api/sacraments').set('Authorization', `Bearer ${tok}`)
      .send({ client_id: m.body.id, type: 'baptism', date: '2020-05-03', minister: seed.minister, place: seed.place })
    expect(sac.status).toBe(201)
    await pool.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, amount, notes) VALUES ($1, $2, $3, $4)`,
      [orgId, seed.donor, seed.amount, seed.giftNote])
    const { rows: ev } = await pool.query(
      `INSERT INTO ochr_calendar_events (organization_id, title, date, start_time, end_time)
       VALUES ($1, $2, '2031-03-01', '10:00', '11:00') RETURNING id`, [orgId, seed.event])
    await pool.query(
      `INSERT INTO ochr_checkins (organization_id, calendar_event_id, person_name, kind, guardian_name)
       VALUES ($1, $2, $3, 'child', $4)`, [orgId, ev[0].id, seed.child, seed.guardian])
  })

  function assertNoParishRecords(msg) {
    expect(msg, 'no attachments, ever').not.toHaveProperty('attachments')
    const body = JSON.stringify(msg)
    const needles = [
      parish.organizationName, slug, member.name, member.email,
      seed.phone, seed.minister, seed.place, seed.donor, seed.amount, seed.giftNote,
      seed.event, seed.child, seed.guardian,
      'openchurch-export', '"tables"', '.json.gz', 'baptism',
    ]
    for (const n of needles) if (n) expect(body, `notification leaks ${n}`).not.toContain(n)
    // The only addresses allowed are the envelope's own: recipient and sender.
    const envelope = new Set([...(msg.to ?? []), String(msg.from ?? '')].map(a => a.replace(/.*<|>.*/g, '')))
    const addrs = (body.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []).filter(a => !envelope.has(a))
    expect(addrs, 'an address from parish records reached the notification').toEqual([])
  }

  it('SUCCESS path: stored, heartbeat carries metadata only', async () => {
    clearEnv()
    const dir = await mkdtemp(join(tmpdir(), 'ochr-bkp-acc-'))
    process.env.BACKUP_STORAGE = 'file'
    process.env.BACKUP_DIR = dir
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.SUPER_ADMIN_EMAIL = `founder_${RUN_ID}@example.com`
    captureResend()

    const res = await runWeeklyBackupDigest()
    expect(res.stored).toBeGreaterThan(0)
    expect(sent.length).toBe(1)
    assertNoParishRecords(sent[0])
    // The heartbeat reports the count that was actually stored, not a
    // canned success. A "0/N stored" note on a good run fails here.
    expect(sent[0].subject).toContain(`${res.stored}/${res.orgs} stored`)
    expect(sent[0].text).toContain(`Stored: ${res.stored} of ${res.orgs}`)
    // and the stored object DOES hold the records — the privacy comes from
    // where the data goes, not from an empty export
    const stamp = new Date().toISOString().slice(0, 10)
    const dump = gunzipSync(await readFile(join(dir, backupKeyFor(orgId, stamp)))).toString('utf8')
    for (const v of [seed.minister, seed.donor, seed.child]) expect(dump).toContain(v)

    // RESTORE COMPATIBILITY: the stored object is the same artifact the
    // restore drill consumes — gzipped buildOrgExport() JSON, same format,
    // same tables, same row counts. Only the path changed.
    const { buildOrgExport } = await import('../src/services/orgExport.js')
    const fresh = await buildOrgExport(orgId)
    const stored = JSON.parse(dump)
    expect(stored.format).toBe(fresh.format)
    expect(Object.keys(stored.tables).sort()).toEqual(Object.keys(fresh.tables).sort())
    expect(stored.counts).toEqual(fresh.counts)
  })

  it('FAILURE path: every store refused, heartbeat reports numeric ids only', async () => {
    const http = await import('node:http')
    const fake = http.createServer((req, res) => { req.resume(); res.writeHead(500); res.end('<Error>boom</Error>') })
    await new Promise(r => fake.listen(0, '127.0.0.1', r))
    clearEnv()
    process.env.BACKUP_STORAGE = 's3'
    process.env.BACKUP_S3_ENDPOINT = `http://127.0.0.1:${fake.address().port}`
    process.env.BACKUP_S3_BUCKET = 'openchurch-backups'
    process.env.BACKUP_S3_REGION = 'us-east-1'
    process.env.BACKUP_S3_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
    process.env.BACKUP_S3_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.SUPER_ADMIN_EMAIL = `founder_${RUN_ID}@example.com`
    captureResend()
    try {
      const res = await runWeeklyBackupDigest()
      expect(res.stored).toBe(0)
      expect(res.store_failures.length).toBeGreaterThan(0)
      expect(sent.length).toBe(1)
      expect(sent[0].subject).toMatch(/problem/)
      expect(sent[0].text).toMatch(new RegExp(`\\b${orgId}\\b`))   // numeric id is allowed
      assertNoParishRecords(sent[0])
    } finally {
      await new Promise(r => fake.close(r))
    }
  })

  it('a Resend failure after storage keeps the counts and is never recorded as sent', async () => {
    clearEnv()
    const dir = await mkdtemp(join(tmpdir(), 'ochr-bkp-sendfail-'))
    process.env.BACKUP_STORAGE = 'file'
    process.env.BACKUP_DIR = dir
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.SUPER_ADMIN_EMAIL = `founder_${RUN_ID}@example.com`
    refuseResend()
    const { monitor } = await import('../src/monitoring/index.js')
    const notifyLog = vi.spyOn(monitor, 'error')
    try {
      const res = await runWeeklyBackupDigest()
      expect(res.stored).toBeGreaterThan(0)
      expect(res.orgs).toBeGreaterThan(0)
      expect(res.notified).toBe(false)
      expect(res.email).not.toBe('heartbeat sent')
      expect(JSON.stringify(res)).not.toContain('heartbeat sent')
      expect(res.notify_error).toMatch(/Resend send failed \(500\)/)
      expect(res.notify_error).not.toContain(parish.organizationName)
      expect(sent.length).toBe(1)
      assertNoParishRecords(sent[0])
      expect(notifyLog.mock.calls.some(c => c[0] === 'backup.digest.notify')).toBe(true)
      const stamp = new Date().toISOString().slice(0, 10)
      expect((await readFile(join(dir, backupKeyFor(orgId, stamp)))).length).toBeGreaterThan(0)
    } finally {
      notifyLog.mockRestore()
    }
  })
})

describe('the heartbeat is built from numbers only (unit)', () => {
  it('a name smuggled into the id lists cannot reach the text', () => {
    const hb = composeBackupHeartbeat({
      stamp: '2026-09-26', orgs: 3, stored: 1,
      failedIds: [`St Evil ${RUN_ID}`], storeFailedIds: [7],
      storageLive: true, storageKind: 's3',
    })
    expect(hb.text).not.toContain('St Evil')
    expect(hb.subject).toMatch(/2 problem/)
    expect(hb.text).toMatch(/organization ids\): 0, 7/)
  })
})
