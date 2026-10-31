// Saint SP-255 (duplicate hint) + SP-256 (mailing address columns).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { bindServer, closeServer, migrateOnce, RUN_ID } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { EXPECTED_MIGRATION, MIGRATION_NAMES } from '../src/migrations/names.js'

let server
const cleanup = []
let ipSeq = 0
const ip = () => `10.88.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 90_000)

afterAll(async () => {
  for (const id of cleanup) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

describe('SP-255 / SP-256 member duplicate hint + mailing address', () => {
it('EXPECTED_MIGRATION is 144-online-giving-clearing (chain through 144-online-giving-clearing)', () => {
    expect(EXPECTED_MIGRATION).toBe('144-online-giving-clearing')
    const i136 = MIGRATION_NAMES.indexOf('136-mass-stipend-liability')
    expect(MIGRATION_NAMES.slice(i136, i136 + 7)).toEqual([
      '136-mass-stipend-liability',
      '137-stripe-connect-account',
      '138-client-mailing-address',
      '139-mass-stipend-followup',
      '140-public-branding',
      '141-public-branding-checks',
      '142-site-documents',
    ])
  })

  it('mailing columns exist and round-trip on POST/PATCH; duplicate-check warns without blocking', async () => {
    const res = await createOrg(server, {
      organizationName: `SP255 Parish ${RUN_ID}`,
      name: 'Office Admin',
      email: `sp255_admin_${RUN_ID}@example.com`,
      password: 'sp255-pw-Office-1',
    }, ip())
    expect(res.status).toBe(201)
    const token = res.body.token
    const orgId = res.body.user.organization.id
    cleanup.push(orgId)

    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'ochr_clients'
         AND column_name LIKE 'mailing_%'
       ORDER BY column_name`)
    expect(cols.rows.map(r => r.column_name)).toEqual([
      'mailing_address_line1', 'mailing_address_line2', 'mailing_city',
      'mailing_postal', 'mailing_state',
    ])

    const a = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Margaret Testcaller',
        email: 'margaret.testcaller@example.invalid',
        mailing_address_line1: '100 Parish Rd',
        mailing_city: 'San Jose',
        mailing_state: 'CA',
        mailing_postal: '95112',
      })
    expect(a.status).toBe(201)
    expect(a.body.mailing_address_line1).toBe('100 Parish Rd')
    expect(a.body.mailing_city).toBe('San Jose')
    expect(JSON.stringify(a.body)).not.toMatch(/calendar_token|swap_token/)

    const dupEmail = await request(server).get('/api/clients/duplicate-check')
      .set('Authorization', `Bearer ${token}`)
      .query({ email: 'Margaret.Testcaller@example.invalid' })
    expect(dupEmail.status).toBe(200)
    expect(dupEmail.body.matches).toHaveLength(1)
    expect(dupEmail.body.matches[0].id).toBe(a.body.id)

    const dupName = await request(server).get('/api/clients/duplicate-check')
      .set('Authorization', `Bearer ${token}`)
      .query({ name: 'margaret testcaller' })
    expect(dupName.status).toBe(200)
    expect(dupName.body.matches.some(m => m.id === a.body.id)).toBe(true)

    // Soft: POST still succeeds for a second person with same email.
    const b = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Margaret Testcaller', email: 'margaret.testcaller@example.invalid' })
    expect(b.status).toBe(201)
    expect(b.body.id).not.toBe(a.body.id)

    const exclude = await request(server).get('/api/clients/duplicate-check')
      .set('Authorization', `Bearer ${token}`)
      .query({ email: 'margaret.testcaller@example.invalid', exclude_id: String(a.body.id) })
    expect(exclude.status).toBe(200)
    expect(exclude.body.matches.every(m => m.id !== a.body.id)).toBe(true)
  })
})

describe('SP-264 mailing fields survive viewer projection', () => {
  it('projectMemberForRole keeps mailing_* for viewer; list/detail return mailing columns', async () => {
    const { projectMemberForRole } = await import('../src/routes/clients.js')
    const row = {
      id: 1, name: 'V', email: 'v@example.invalid', phone: null, notes: 'secret',
      birth_date: '1990-01-01', mailing_address_line1: '1 Main', mailing_city: 'X',
      mailing_state: 'CA', mailing_postal: '99999', mailing_address_line2: null,
    }
    const v = projectMemberForRole(row, 'viewer')
    expect(v.mailing_address_line1).toBe('1 Main')
    expect(v.mailing_city).toBe('X')
    expect(v.notes).toBeUndefined()
    expect(v.birth_date).toBeUndefined()
    const a = projectMemberForRole(row, 'admin')
    expect(a.notes).toBe('secret')
    expect(a.mailing_address_line1).toBe('1 Main')

    const res = await createOrg(server, {
      organizationName: `SP264 Parish ${RUN_ID}`,
      name: 'Office Admin',
      email: `sp264_admin_${RUN_ID}@example.com`,
      password: 'sp264-pw-Office-1',
    }, ip())
    expect(res.status).toBe(201)
    const token = res.body.token
    cleanup.push(res.body.user.organization.id)

    const created = await request(server).post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Viewer Address Probe',
        email: 'viewer.address@example.invalid',
        mailing_address_line1: '789 Edited Probe Road',
        mailing_city: 'San Jose',
        mailing_state: 'CA',
        mailing_postal: '95112',
      })
    expect(created.status).toBe(201)

    const detail = await request(server).get(`/api/clients/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(detail.status).toBe(200)
    expect(detail.body.mailing_address_line1).toBe('789 Edited Probe Road')
    expect(detail.body.mailing_city).toBe('San Jose')

    const list = await request(server).get('/api/clients')
      .set('Authorization', `Bearer ${token}`)
    const hit = list.body.find(m => m.id === created.body.id)
    expect(hit?.mailing_address_line1).toBe('789 Edited Probe Road')
    expect(hit?.mailing_postal).toBe('95112')
  })
})
