// A sacramental record names who the sacrament was for, AS RECORDED.
// (Pass 8 §2–§6)
//
// The register is a historical document. The member roster is a present-day
// one. They were sharing an identity: every read resolved the subject as
// COALESCE(c.name, s.member_name) — the LIVE member name first — so renaming
// a member silently rewrote every sacramental record and certificate that
// pointed at them.
//
//   Maria Ruiz is baptised in 2019. The entry says Maria Ruiz.
//   She marries in 2026 and her member record becomes Maria Ruiz Garcia.
//   Her BAPTISMAL certificate began reading Maria Ruiz Garcia.
//
// A member link is a relationship. It is not the historical record.
//
// This is OpenChurch's data-integrity rule. It is NOT a claim about canon
// law, which differs by tradition.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, app, bindServer, closeServer, migrateOnce } from './support/harness.js'

let server, token
const auth = (r) => r.set('Authorization', `Bearer ${token}`)

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const signup = await request(server).post('/api/auth/signup')
    .set('X-Forwarded-For', '10.99.77.44')
    .send({
      organizationName: `Register Parish ${RUN_ID}`,
      name: 'Register Admin',
      email: `reg_${RUN_ID}@example.com`,
      password: 'smoke-test-pw-882',
    })
  expect(signup.status).toBe(201)
  token = signup.body.token
}, 60_000)

afterAll(async () => { await closeServer(server); await pool.end() })

const newMember = async (name) => {
  const res = await auth(request(server).post('/api/clients')).send({ name })
  expect(res.status).toBe(201)
  return res.body.id
}
const newRecord = (body) => auth(request(server).post('/api/sacraments')).send(body)
const readRecord = (id) => auth(request(server).get(`/api/sacraments/${id}`))

describe('A. a linked current member', () => {
  it('snapshots the name at the moment the record is made', async () => {
    const id = await newMember('Snapshot Subject')
    const rec = await newRecord({ client_id: id, type: 'baptism', date: '2019-05-10' })
    expect(rec.status).toBe(201)
    expect(rec.body.member_name).toBe('Snapshot Subject')
  })
})

describe('B. an unlinked historic subject', () => {
  it('records a person who is not, and may never be, a member', async () => {
    // Historic register digitisation involves people who died decades ago.
    // Requiring a member row for them would put the dead on the parish
    // roster so that a certificate could print.
    const rec = await newRecord({
      member_name: 'Ana Delgado', type: 'baptism', date: '1953-03-14',
      minister: 'Fr. Ibarra', place: 'San Miguel',
    })
    expect(rec.status).toBe(201)
    expect(rec.body.client_id).toBeNull()
    const read = await readRecord(rec.body.id)
    expect(read.body.member_name).toBe('Ana Delgado')
  })
})

describe('C. the member is renamed after the sacrament', () => {
  it('THE CASE: a baptismal certificate keeps the name that was baptised', async () => {
    const memberId = await newMember('Maria Ruiz')
    const rec = await newRecord({
      client_id: memberId, type: 'baptism', date: '2019-05-10',
      minister: 'Fr. Alvarez', certificate_no: 'MR-001',
    })
    expect(rec.body.member_name).toBe('Maria Ruiz')

    const rename = await auth(request(server).patch(`/api/clients/${memberId}`))
      .send({ name: 'Maria Ruiz Garcia' })
    expect(rename.status).toBe(200)
    expect(rename.body.name).toBe('Maria Ruiz Garcia')

    // The certificate view reads GET /api/sacraments/:id.
    const cert = await readRecord(rec.body.id)
    expect(cert.body.member_name).toBe('Maria Ruiz')

    // And so does the parish register.
    const list = await auth(request(server).get('/api/sacraments?limit=100'))
    const row = list.body.records.find(r => r.certificate_no === 'MR-001')
    expect(row.member_name).toBe('Maria Ruiz')

    // The relationship survives — it is the identity that does not move.
    expect(cert.body.client_id).toBe(memberId)
  })

  it('linking a record to a member later does not rewrite what it recorded', async () => {
    // Discovering that a 1953 entry belongs to a member alive today is
    // learning a relationship, not evidence the register said something else.
    const rec = await newRecord({ member_name: 'Ana Delgado', type: 'confirmation', date: '1961-06-01' })
    const memberId = await newMember('Ana D. Ibarra')
    const link = await auth(request(server).patch(`/api/sacraments/${rec.body.id}`))
      .send({ client_id: memberId, reason: 'Matched to her member record.' })
    expect(link.status).toBe(200)
    const read = await readRecord(rec.body.id)
    expect(read.body.member_name).toBe('Ana Delgado')
    expect(read.body.client_id).toBe(memberId)
  })
})

describe('D. correcting the historical name', () => {
  it('requires a reason and lands in the amendment history with before and after', async () => {
    const rec = await newRecord({ member_name: 'Maria Ruis', type: 'baptism', date: '1994-02-02' })

    const noReason = await auth(request(server).patch(`/api/sacraments/${rec.body.id}`))
      .send({ member_name: 'Maria Ruiz' })
    expect(noReason.status).toBe(400)

    const fixed = await auth(request(server).patch(`/api/sacraments/${rec.body.id}`))
      .send({ member_name: 'Maria Ruiz', reason: 'Corrected spelling from the original register notation.' })
    expect(fixed.status).toBe(200)
    expect(fixed.body.member_name).toBe('Maria Ruiz')

    const hist = await auth(request(server).get(`/api/sacraments/${rec.body.id}/amendments`))
    const correction = hist.body.amendments.at(-1)
    expect(correction.kind).toBe('correction')
    // The previous name must be IN the history. It was not, at first: the
    // snapshot selected a column list that omitted member_name, so a name
    // correction recorded `before: null` — which reads as though the entry
    // had never named anyone.
    expect(correction.before_json.member_name).toBe('Maria Ruis')
    expect(correction.after_json.member_name).toBe('Maria Ruiz')
    expect(correction.reason).toMatch(/original register notation/)
    expect(correction.amended_by_name).toBeTruthy()
  })
})

describe('E. an imported historical record', () => {
  it('can be staged with its subject and commits with that subject intact', async () => {
    const staged = await auth(request(server).post('/api/sacraments/drafts')).send({
      drafts: [{ source: 'csv', draft: {
        member_name: 'Josefa Marquez', type: 'baptism', date: '1948-11-03',
        minister: 'Fr. Solis', place: 'Santa Cruz',
      } }],
    })
    expect(staged.status).toBe(201)
    const draftId = staged.body.drafts[0].id

    const committed = await auth(request(server).post(`/api/sacraments/drafts/${draftId}/commit`)).send({})
    expect(committed.status).toBe(201)
    const read = await readRecord(committed.body.record.id ?? committed.body.id)
    expect(read.body.member_name).toBe('Josefa Marquez')
  })
})

describe('F. a record that names nobody', () => {
  it('cannot be created', async () => {
    const res = await newRecord({ type: 'baptism', date: '1960-01-01' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/must name its subject/i)
  })

  it('cannot be created by blanking the name either', async () => {
    const res = await newRecord({ member_name: '   ', type: 'baptism', date: '1960-01-01' })
    expect(res.status).toBe(400)
  })

  it('cannot be produced by a correction that erases the subject', async () => {
    const rec = await newRecord({ member_name: 'Temporary Subject', type: 'baptism', date: '1970-01-01' })
    const res = await auth(request(server).patch(`/api/sacraments/${rec.body.id}`))
      .send({ member_name: '', reason: 'attempting to blank the subject' })
    expect(res.status).toBe(400)
    // And the record is untouched.
    const read = await readRecord(rec.body.id)
    expect(read.body.member_name).toBe('Temporary Subject')
  })

  // Pass 8 allowed this ("a linked member can still answer who it is") and
  // the audit that followed showed why it must not: the cleared snapshot
  // reopened the live-identity path. Rename the member and the register
  // followed the rename; delete the member and the entry named nobody; and
  // the amendment trail showed a name going to null with nothing to say who
  // the entry was about. The link is a convenience for the roster. The name
  // is the record. (Boss Fight I, D3a — see registerTruth.test.js)
  it('cannot have its name cleared even when a linked member could answer for it', async () => {
    const memberId = await newMember('Linked Answerer')
    const rec = await newRecord({ client_id: memberId, type: 'baptism', date: '1980-01-01' })
    const res = await auth(request(server).patch(`/api/sacraments/${rec.body.id}`))
      .send({ member_name: '', reason: 'falling back to the linked member' })
    expect(res.status).toBe(400)
    const read = await readRecord(rec.body.id)
    expect(read.body.member_name).toBe('Linked Answerer')
  })
})
