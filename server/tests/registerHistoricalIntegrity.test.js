// OC-CYCLE-MAX-04 / REGISTER-L3-01 — sacramental historical integrity.
//
// Probes are T0 → action → T1 on a synthetic parish. They do not backfill
// history and they do not touch a database that is not the local test
// target. A green run of this file is not Carolina's or Argus's review.
//
// What this file is for:
//   - recorded name stays put when the roster is edited
//   - a missing snapshot stays unavailable (it is not filled from the roster)
//   - anniversaries and the weekly digest speak the recorded name
//   - a correction is a linked amendment; void is not delete
//   - the demo seeder records the name the fixture already knows

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { enqueueSacramentAnniversaryDigests } from '../src/notifications/sacramentAnniversaries.js'
import { PARISH } from '../src/demo/stBrigids.js'

let server, token, orgId
const auth = (r) => r.set('Authorization', `Bearer ${token}`)

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const signup = await request(server).post('/api/auth/signup')
    .set('X-Forwarded-For', '10.99.77.46')
    .send({
      organizationName: `Register L3 ${RUN_ID}`,
      name: 'Register L3 Admin',
      email: `regl3_${RUN_ID}@example.com`,
      password: 'smoke-test-pw-884',
    })
  expect(signup.status).toBe(201)
  token = signup.body.token
  const { rows } = await pool.query('SELECT id FROM ochr_organizations WHERE name = $1', [`Register L3 ${RUN_ID}`])
  orgId = rows[0].id
}, 60_000)

afterAll(async () => { await closeServer(server); await pool.end() })

const newMember = async (name, extra = {}) => {
  const res = await auth(request(server).post('/api/clients')).send({ name, ...extra })
  expect(res.status).toBe(201)
  return res.body.id
}
const newRecord = (body) => auth(request(server).post('/api/sacraments')).send(body)
const readRecord = (id) => auth(request(server).get(`/api/sacraments/${id}`))

const pad = n => String(n).padStart(2, '0')
function anniversaryDate(daysAhead, yearsAgo, from = new Date()) {
  const t = new Date(from); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() + daysAhead)
  if (t.getMonth() === 1 && t.getDate() === 29) t.setDate(t.getDate() + 1)
  return `${t.getFullYear() - yearsAgo}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

describe('recorded identity stays distinct from a later roster edit', () => {
  it('the certificate source keeps the baptised name after the member is renamed and otherwise edited', async () => {
    const memberId = await newMember('Maria Ruiz', { email: 'maria.ruiz@example.com', phone: '555-0100' })
    const rec = await newRecord({
      client_id: memberId, type: 'baptism', date: '2019-05-10',
      minister: 'Fr. Alvarez', place: 'The Parish Church', certificate_no: 'L3-MR-001',
      meta_attributes: { godparents: ['Ana Ruiz', 'Jose Ruiz'] },
    })
    expect(rec.status).toBe(201)
    const t0 = rec.body

    const rename = await auth(request(server).patch(`/api/clients/${memberId}`)).send({
      name: 'Maria Ruiz Garcia',
      email: 'maria.garcia@example.com',
      phone: '555-0199',
      birth_date: '2019-04-01',
    })
    expect(rename.status).toBe(200)

    const t1 = await readRecord(rec.body.id)
    expect(t1.status).toBe(200)
    expect(t1.body.member_name).toBe('Maria Ruiz')
    expect(t1.body.date).toBe('2019-05-10')
    expect(t1.body.minister).toBe('Fr. Alvarez')
    expect(t1.body.place).toBe('The Parish Church')
    expect(t1.body.certificate_no).toBe('L3-MR-001')
    expect(t1.body.meta_attributes.godparents).toEqual(['Ana Ruiz', 'Jose Ruiz'])
    expect(t1.body.client_id).toBe(memberId)
    // The extract is the register row. Roster contact fields are not facts on it.
    expect(t1.body.email).toBeUndefined()
    expect(t1.body.phone).toBeUndefined()
    expect(t1.body.birth_date).toBeUndefined()
    expect(t1.body.member_name).toBe(t0.member_name)
  })

  it('anniversaries name the person the register recorded, not the name they use now', async () => {
    const memberId = await newMember('Ana Baptismal')
    const rec = await newRecord({
      client_id: memberId, type: 'baptism', date: anniversaryDate(2, 6),
    })
    expect(rec.status).toBe(201)
    expect(rec.body.member_name).toBe('Ana Baptismal')

    const rename = await auth(request(server).patch(`/api/clients/${memberId}`)).send({ name: 'Ana Married Name' })
    expect(rename.status).toBe(200)

    const list = await auth(request(server).get('/api/sacraments/anniversaries?days=7'))
    expect(list.status).toBe(200)
    const hit = list.body.anniversaries.find(a => a.id === rec.body.id)
    expect(hit).toBeTruthy()
    expect(hit.member_name).toBe('Ana Baptismal')
    expect(hit.member_name).not.toBe('Ana Married Name')
  })

  it('the weekly digest does not rewrite the historical subject to the current roster name', async () => {
    const now = new Date(); now.setHours(0, 0, 0, 0); now.setDate(now.getDate() + 140)
    const memberId = await newMember('Digest Baptismal')
    const rec = await newRecord({
      client_id: memberId, type: 'confirmation', date: anniversaryDate(2, 4, now),
    })
    expect(rec.status).toBe(201)
    const rename = await auth(request(server).patch(`/api/clients/${memberId}`)).send({ name: 'Digest Married' })
    expect(rename.status).toBe(200)

    const result = await enqueueSacramentAnniversaryDigests({ now })
    expect(result.digestsEnqueued).toBeGreaterThanOrEqual(1)

    const { rows } = await pool.query(
      `SELECT vars FROM ochr_scheduled_notifications
        WHERE organization_id = $1 AND notification_type = 'sacrament_anniversary_digest'`,
      [orgId]
    )
    const blocks = rows.map(r => r.vars.items_block)
    expect(blocks.some(b => b.includes('Digest Baptismal'))).toBe(true)
    expect(blocks.some(b => b.includes('Digest Married'))).toBe(false)
  })
})

describe('a missing snapshot stays unavailable', () => {
  const nullSnapshot = async (clientId) => {
    const rec = await newRecord({ client_id: clientId, type: 'baptism', date: '1991-02-02' })
    expect(rec.status).toBe(201)
    await pool.query(
      'UPDATE ochr_sacramental_records SET member_name = NULL WHERE id = $1 AND organization_id = $2',
      [rec.body.id, orgId]
    )
    return rec.body.id
  }

  it('does not present the live roster name as the name in the book', async () => {
    const memberId = await newMember('Legacy Live Name')
    const id = await nullSnapshot(memberId)

    const read = await readRecord(id)
    expect(read.status).toBe(200)
    expect(read.body.member_name).toBeNull()

    const list = await auth(request(server).get('/api/sacraments').query({ q: 'Legacy Live Name', limit: 100 }))
    expect(list.status).toBe(200)
    expect(list.body.records.some(r => r.id === id)).toBe(false)

    const rename = await auth(request(server).patch(`/api/clients/${memberId}`)).send({ name: 'Legacy Renamed' })
    expect(rename.status).toBe(200)
    const after = await readRecord(id)
    expect(after.body.member_name).toBeNull()
  })

  it('refuses to copy a roster name into the book when the link changes', async () => {
    const oldId = await newMember('Stamp Source')
    const newId = await newMember('Stamp Target')
    const id = await nullSnapshot(oldId)

    const relink = await auth(request(server).patch(`/api/sacraments/${id}`)).send({
      client_id: newId, reason: 'Matched to a member without a name from the book.',
    })
    expect(relink.status).toBe(400)
    expect(relink.body.error).toMatch(/must name its subject/i)

    const { rows } = await pool.query(
      'SELECT member_name, client_id FROM ochr_sacramental_records WHERE id = $1 AND organization_id = $2',
      [id, orgId]
    )
    expect(rows[0].member_name).toBeNull()
    expect(Number(rows[0].client_id)).toBe(oldId)

    const named = await auth(request(server).patch(`/api/sacraments/${id}`)).send({
      client_id: newId,
      member_name: 'Name From The Register Page',
      reason: 'Name read from the paper register before the link was changed.',
    })
    expect(named.status).toBe(200)
    expect(named.body.member_name).toBe('Name From The Register Page')
    expect(named.body.client_id).toBe(newId)

    const hist = await auth(request(server).get(`/api/sacraments/${id}/amendments`))
    const last = hist.body.amendments.at(-1)
    expect(last.kind).toBe('correction')
    expect(last.before_json.member_name).toBeNull()
    expect(last.after_json.member_name).toBe('Name From The Register Page')
    expect(last.after_json.member_name).not.toBe('Stamp Source')
    expect(last.after_json.member_name).not.toBe('Stamp Target')
  })

  it('a digest does not draft a historical claim under the live name when the book has none', async () => {
    const now = new Date(); now.setHours(0, 0, 0, 0); now.setDate(now.getDate() + 200)
    const memberId = await newMember('Unrecorded Digest Subject')
    const rec = await newRecord({
      client_id: memberId, type: 'baptism', date: anniversaryDate(3, 8, now),
    })
    expect(rec.status).toBe(201)
    await pool.query(
      'UPDATE ochr_sacramental_records SET member_name = NULL WHERE id = $1 AND organization_id = $2',
      [rec.body.id, orgId]
    )

    await enqueueSacramentAnniversaryDigests({ now })
    const { rows } = await pool.query(
      `SELECT vars FROM ochr_scheduled_notifications
        WHERE organization_id = $1 AND notification_type = 'sacrament_anniversary_digest'`,
      [orgId]
    )
    const blocks = rows.map(r => r.vars.items_block).join('\n')
    expect(blocks.includes('Unrecorded Digest Subject')).toBe(false)
  })
})

describe('correction is linked; void is not delete', () => {
  it('a correction keeps before and after, and DELETE does not remove the entry', async () => {
    const rec = await newRecord({
      member_name: 'Corrected Subject', type: 'baptism', date: '1988-08-08',
      place: 'Old Chapel', minister: 'Fr. Hale',
    })
    expect(rec.status).toBe(201)

    const bare = await auth(request(server).patch(`/api/sacraments/${rec.body.id}`)).send({ place: 'The Parish Church' })
    expect(bare.status).toBe(400)

    const fixed = await auth(request(server).patch(`/api/sacraments/${rec.body.id}`)).send({
      place: 'The Parish Church',
      reason: 'Place misread from the 1988 paper register.',
    })
    expect(fixed.status).toBe(200)
    expect(fixed.body.place).toBe('The Parish Church')
    expect(fixed.body.member_name).toBe('Corrected Subject')

    const hist = await auth(request(server).get(`/api/sacraments/${rec.body.id}/amendments`))
    const correction = hist.body.amendments.at(-1)
    expect(correction.kind).toBe('correction')
    expect(correction.before_json.place).toBe('Old Chapel')
    expect(correction.after_json.place).toBe('The Parish Church')
    expect(correction.before_json.member_name).toBe('Corrected Subject')
    const { rows: linked } = await pool.query(
      'SELECT sacrament_id FROM ochr_sacrament_amendments WHERE id = $1 AND organization_id = $2',
      [correction.id, orgId]
    )
    expect(Number(linked[0].sacrament_id)).toBe(Number(rec.body.id))

    const del = await auth(request(server).delete(`/api/sacraments/${rec.body.id}`))
    expect(del.status).toBe(405)
    expect(del.body.void_endpoint).toBe(`/api/sacraments/${rec.body.id}/void`)

    const voided = await auth(request(server).post(`/api/sacraments/${rec.body.id}/void`)).send({
      reason: 'Duplicate of an earlier entry in the same book.',
    })
    expect(voided.status).toBe(200)
    expect(voided.body.voided_at).toBeTruthy()

    const still = await readRecord(rec.body.id)
    expect(still.status).toBe(200)
    expect(still.body.member_name).toBe('Corrected Subject')
    expect(still.body.place).toBe('The Parish Church')
    expect(still.body.voided_at).toBeTruthy()

    const { rows } = await pool.query(
      'SELECT id FROM ochr_sacramental_records WHERE id = $1 AND organization_id = $2',
      [rec.body.id, orgId]
    )
    expect(rows).toHaveLength(1)
  })
})

describe('the demo seeder records the historical subject it already knows', () => {
  it('stores baptismal names that the living roster no longer uses', async () => {
    const signup = await request(server).post('/api/auth/signup')
      .set('X-Forwarded-For', '10.99.77.47')
      .send({
        organizationName: PARISH.name,
        name: 'Demo Seeder Admin',
        email: `seedl3_${RUN_ID}@example.com`,
        password: 'smoke-test-pw-885',
      })
    expect(signup.status).toBe(201)
    const { rows } = await pool.query(
      'SELECT id FROM ochr_organizations WHERE name = $1 ORDER BY id DESC LIMIT 1',
      [PARISH.name]
    )
    const demoOrg = rows[0].id

    const run = spawnSync(process.execPath, ['src/demo/seedStBrigids.js', '--org', String(demoOrg)], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
        JWT_SECRET: process.env.JWT_SECRET || 'ci-test-secret-not-used-in-prod',
        CHECKIN_CODE_PEPPER: process.env.CHECKIN_CODE_PEPPER || 'ci-test-pepper-not-used-in-prod',
      },
      encoding: 'utf8',
    })
    expect(run.status, run.stderr || run.stdout).toBe(0)

    const { rows: margaret } = await pool.query(
      `SELECT member_name, client_id, type, to_char(date, 'YYYY-MM-DD') AS date
         FROM ochr_sacramental_records
        WHERE organization_id = $1 AND type = 'baptism' AND date = '1952-05-25'`,
      [demoOrg]
    )
    expect(margaret).toHaveLength(1)
    expect(margaret[0].member_name).toBe('Margaret Anne Kelleher')
    expect(margaret[0].client_id).toBeNull()

    const { rows: jennifer } = await pool.query(
      `SELECT member_name, client_id FROM ochr_sacramental_records
        WHERE organization_id = $1 AND type = 'baptism' AND date = '1968-09-08'`,
      [demoOrg]
    )
    expect(jennifer).toHaveLength(1)
    expect(jennifer[0].member_name).toBe('Jennifer Lynn Whitfield')
    expect(jennifer[0].client_id).toBeNull()

    const { rows: unnamed } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_sacramental_records
        WHERE organization_id = $1 AND member_name IS NULL`,
      [demoOrg]
    )
    expect(unnamed[0].n).toBe(0)
  }, 60_000)
})
