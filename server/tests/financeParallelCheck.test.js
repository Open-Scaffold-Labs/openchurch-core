// Side-by-side proof (Landscape pattern #5, José 2026-10-25). A parish runs
// its old system and OpenChurch together until the totals match to $0.00.
// POST /api/finance/parallel-check compares an old-system trial balance
// (account_code, amount) to OpenChurch's live totals for the same dates and
// reports the variance per account in integer cents. It READS ONLY: the old
// numbers are never written into the ledger.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, token, orgId
const cleanup = []

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const res = await createOrg(server, { organizationName: `PC Parish ${RUN_ID}`, name: 'PC Admin',
    email: `pc_admin_${RUN_ID}@openchurch.test`, password: 'parallel-check-pw-1' }, '10.62.1.1')
  expect(res.status).toBe(201)
  token = res.body.token; orgId = res.body.user.organization.id; cleanup.push(orgId)
  const imp = await request(server).post('/api/finance/ledger/import').set('Authorization', `Bearer ${token}`)
    .send({ csv: 'account_code,amount\n1110,1120.05\n4310,1200.10\n5210,80.05', as_of: '2027-05-31' })
  expect(imp.status).toBe(201)
}, 60_000)

afterAll(async () => {
  for (const id of cleanup) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

const check = body => request(server).post('/api/finance/parallel-check').set('Authorization', `Bearer ${token}`).send(body)
const ledgerCount = async () => (await pool.query('SELECT COUNT(*)::int n FROM ochr_ledger_entries WHERE organization_id = $1', [orgId])).rows[0].n

describe('POST /api/finance/parallel-check', () => {
  it('reports zero variance when the old system matches to the penny, and writes nothing', async () => {
    const before = await ledgerCount()
    const res = await check({ csv: 'account_code,amount\n1110,1120.05\n4310,1200.10\n5210,80.05', start: '2027-05-01', end: '2027-05-31' })
    expect(res.status).toBe(200)
    expect(res.body.zero_variance).toBe(true)
    expect(res.body.total_variance_cents).toBe(0)
    expect(res.body.accounts.map(a => [a.code, a.openchurch_cents, a.old_system_cents, a.variance_cents]))
      .toEqual([['1110', 112005, 112005, 0], ['4310', 120010, 120010, 0], ['5210', 8005, 8005, 0]])
    expect(await ledgerCount()).toBe(before)
  })

  it('shows a one-cent difference and lists accounts only one side has', async () => {
    const res = await check({ csv: 'account_code,amount\n4310,1200.09\n4310,0.00\n5310,15.00', start: '2027-05-01', end: '2027-05-31' })
    expect(res.status).toBe(200)
    expect(res.body.zero_variance).toBe(false)
    const by = Object.fromEntries(res.body.accounts.map(a => [a.code, a]))
    expect(by['4310'].variance_cents).toBe(1)
    expect(by['5210']).toMatchObject({ openchurch_cents: 8005, old_system_cents: 0, variance_cents: 8005 })
    expect(by['5310']).toMatchObject({ openchurch_cents: 0, old_system_cents: 1500, variance_cents: -1500 })
  })

  it('never claims zero variance when a row could not be read', async () => {
    const res = await check({ csv: 'account_code,amount\n4310,1200.10\n5210,80.05\n5310,12.345\nabc,1', start: '2027-05-01', end: '2027-05-31' })
    expect(res.status).toBe(200)
    // R413-1: the readable rows match to the penny, but the comparison is
    // incomplete, so no total is given — never an apparent $0.00.
    expect(res.body.total_variance_cents).toBeNull()
    expect(res.body.complete).toBe(false)
    expect(res.body.zero_variance).toBe(false)
    expect(res.body.errors.map(e => e.line)).toEqual([4, 5])
  })

  it('reports complete with a numeric total only when every row was read', async () => {
    const res = await check({ csv: 'account_code,amount\n1110,1120.05\n4310,1200.10\n5210,80.05', start: '2027-05-01', end: '2027-05-31' })
    expect(res.body.complete).toBe(true)
    expect(res.body.total_variance_cents).toBe(0)
  })

  it('rejects a missing period or column', async () => {
    expect((await check({ csv: 'account_code,amount\n4310,1', start: '2027-05-01' })).status).toBe(400)
    expect((await check({ csv: 'code,amount\n4310,1', start: '2027-05-01', end: '2027-05-31' })).status).toBe(400)
    expect((await check({ csv: 'account_code,amount\n4310,1', start: '2027-06-01', end: '2027-05-31' })).status).toBe(400)
  })

  it('is scoped to the caller\'s parish', async () => {
    const other = await createOrg(server, { organizationName: `PC Other ${RUN_ID}`, name: 'Other',
      email: `pc_other_${RUN_ID}@openchurch.test`, password: 'parallel-check-pw-2' }, '10.62.1.2')
    cleanup.push(other.body.user.organization.id)
    const res = await request(server).post('/api/finance/parallel-check').set('Authorization', `Bearer ${other.body.token}`)
      .send({ csv: 'account_code,amount\n4310,0', start: '2027-05-01', end: '2027-05-31' })
    expect(res.status).toBe(200)
    expect(res.body.accounts.find(a => a.code === '5210')).toBeUndefined()
  })
})
