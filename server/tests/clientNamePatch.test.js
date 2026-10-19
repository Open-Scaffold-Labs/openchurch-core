import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

// PATCH /api/clients/:id applies the same name rule as POST and CSV import:
// a present name is a non-blank string, stored trimmed. Before, '' became
// NULL and hit the NOT NULL constraint (500), and '   ' saved a blank name.
let server
let org
let memberId
const auth = token => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  const r = await createOrg(server, {
    organizationName: `Name Patch ${RUN_ID}`, name: 'Synthetic Admin',
    email: `name_patch_${RUN_ID}@example.com`, password: 'name-patch-test-pw',
  }, '10.93.1.1')
  expect(r.status).toBe(201)
  org = { id: r.body.user.organization.id, token: r.body.token }
  const created = await request(server).post('/api/clients').set(auth(org.token)).send({ name: 'Synthetic Person' })
  expect(created.status).toBe(201)
  memberId = created.body.id
}, 60000)

afterAll(async () => {
  if (org) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.id])
  await closeServer(server); await pool.end()
})

async function storedName() {
  const { rows: [row] } = await pool.query('SELECT name FROM ochr_clients WHERE id = $1 AND organization_id = $2', [memberId, org.id])
  return row.name
}

describe('PATCH /api/clients/:id name', () => {
  for (const [label, name] of [
    ['an empty name', ''],
    ['a whitespace-only name', '   '],
    ['a null name', null],
    ['a non-string name', 42],
  ]) {
    it(`refuses ${label} with 400 and leaves the record unchanged`, async () => {
      const r = await request(server).patch(`/api/clients/${memberId}`).set(auth(org.token)).send({ name, notes: 'must not land' })
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('Name is required')
      expect(await storedName()).toBe('Synthetic Person')
      const { rows: [row] } = await pool.query('SELECT notes FROM ochr_clients WHERE id = $1', [memberId])
      expect(row.notes).toBeNull()
    })
  }

  it('stores a padded name trimmed', async () => {
    const r = await request(server).patch(`/api/clients/${memberId}`).set(auth(org.token)).send({ name: '  Renamed Person  ' })
    expect(r.status).toBe(200)
    expect(r.body.name).toBe('Renamed Person')
    expect(await storedName()).toBe('Renamed Person')
  })

  it('CONTROL: a PATCH without name still updates other fields and keeps the name', async () => {
    const before = await storedName()
    const r = await request(server).patch(`/api/clients/${memberId}`).set(auth(org.token)).send({ company: 'Synthetic Co' })
    expect(r.status).toBe(200)
    expect(r.body.company).toBe('Synthetic Co')
    expect(await storedName()).toBe(before)
  })
})
