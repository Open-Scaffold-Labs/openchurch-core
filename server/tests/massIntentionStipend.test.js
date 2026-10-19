// Mass intention offering — the server must refuse a stipend that is not a
// real amount. Empty string, NaN, Infinity, negatives, and other values
// Number() would turn into plausible money are not stored. Null and a
// missing field remain "no stipend". Zero is a real amount.
//
// JSON cannot carry NaN or Infinity (they stringify to null). Those two
// reach the route as the strings "NaN" / "Infinity" / "-Infinity", which
// node-pg would persist as numeric NaN. Actual JS NaN / Infinity are
// refused by readStipend, the same reader POST and PATCH call.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { readStipend, STIPEND_REFUSED } from '../src/routes/massIntentions.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let tokenA, tokenB, orgAId

const marker = label => `Stipend probe ${RUN_ID} ${label}`

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const a = await createOrg(server, {
    organizationName: `Stipend Parish A ${RUN_ID}`,
    name: 'Ada Admin',
    email: `stipend_a_${RUN_ID}@example.com`,
    password: 'stipend-test-pw-1',
  })
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgAId = a.body.user.organization.id

  const b = await createOrg(server, {
    organizationName: `Stipend Parish B ${RUN_ID}`,
    name: 'Bea Admin',
    email: `stipend_b_${RUN_ID}@example.com`,
    password: 'stipend-test-pw-2',
  })
  expect(b.status).toBe(201)
  tokenB = b.body.token
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

async function storedCount(intention) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM ochr_mass_intentions
      WHERE organization_id = $1 AND intention = $2`,
    [orgAId, intention]
  )
  return rows[0].n
}

async function storedStipend(id) {
  const { rows } = await pool.query(
    `SELECT stipend::text AS stipend
       FROM ochr_mass_intentions
      WHERE id = $1 AND organization_id = $2`,
    [id, orgAId]
  )
  return rows.length ? rows[0].stipend : undefined
}

function post(body) {
  return request(server).post('/api/mass-intentions')
    .set('Authorization', `Bearer ${tokenA}`)
    .send(body)
}

function patch(id, body, token = tokenA) {
  return request(server).patch(`/api/mass-intentions/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

// Values the route must not persist. Each one is a separate input the
// claim names, or a Number() coercion into 0 / some other amount.
const REFUSED = [
  ['empty string', ''],
  ['whitespace', '   '],
  ['NaN string', 'NaN'],
  ['Infinity string', 'Infinity'],
  ['negative Infinity string', '-Infinity'],
  ['negative number', -5],
  ['negative string', '-5'],
  ['non-numeric text', 'nope'],
  ['boolean true', true],
  ['boolean false', false],
  ['empty array', []],
  ['object', {}],
  ['exponent string', '1e2'],
  ['padded amount', ' 10.00'],
  ['extra fraction', 10.555],
  ['above numeric max', 100000000],
]

describe('POST /api/mass-intentions stipend', () => {
  it.each(REFUSED)('refuses %s and stores nothing', async (label, stipend) => {
    const intention = marker(`post ${label}`)
    const res = await post({ intention, stipend })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(STIPEND_REFUSED)
    expect(await storedCount(intention)).toBe(0)
  })

  it('stores a missing stipend as no stipend', async () => {
    const intention = marker('post omitted')
    const res = await post({ intention })
    expect(res.status).toBe(201)
    expect(res.body.stipend).toBeNull()
    expect(await storedStipend(res.body.id)).toBeNull()
  })

  it('stores JSON null as no stipend', async () => {
    const intention = marker('post null')
    const res = await post({ intention, stipend: null })
    expect(res.status).toBe(201)
    expect(res.body.stipend).toBeNull()
    expect(await storedStipend(res.body.id)).toBeNull()
  })

  it.each([
    ['zero', 0, '0.00'],
    ['ten', 10, '10.00'],
    ['ten fifty number', 10.5, '10.50'],
    ['ten fifty string', '10.50', '10.50'],
    ['zero string', '0.00', '0.00'],
    ['whole string', '10', '10.00'],
    ['one decimal string', '10.5', '10.50'],
    ['twenty-nine cents', 0.29, '0.29'],
    ['max numeric', 99999999.99, '99999999.99'],
  ])('stores %s unchanged', async (label, stipend, stored) => {
    const intention = marker(`post ok ${label}`)
    const res = await post({ intention, requested_by: 'Sample requester', stipend })
    expect(res.status).toBe(201)
    expect(res.body.stipend).toBe(stored)
    expect(await storedStipend(res.body.id)).toBe(stored)
  })
})

describe('PATCH /api/mass-intentions/:id stipend', () => {
  async function withAmount(amount, label) {
    const created = await post({ intention: marker(label), stipend: amount })
    expect(created.status).toBe(201)
    return created.body.id
  }

  it.each(REFUSED)('refuses %s and leaves the stored offering', async (label, stipend) => {
    const id = await withAmount(10, `patch ${label}`)
    const res = await patch(id, { stipend })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(STIPEND_REFUSED)
    expect(await storedStipend(id)).toBe('10.00')
  })

  it('clears the offering when the stipend is JSON null', async () => {
    const id = await withAmount(10, 'patch null')
    const res = await patch(id, { stipend: null })
    expect(res.status).toBe(200)
    expect(res.body.stipend).toBeNull()
    expect(await storedStipend(id)).toBeNull()
  })

  it('keeps the offering when the stipend is omitted', async () => {
    const id = await withAmount(15, 'patch omit')
    const res = await patch(id, { note: 'still the same offering' })
    expect(res.status).toBe(200)
    expect(res.body.stipend).toBe('15.00')
    expect(await storedStipend(id)).toBe('15.00')
  })

  it('replaces a real offering with another real offering', async () => {
    const id = await withAmount(10, 'patch replace')
    const res = await patch(id, { stipend: '25.50' })
    expect(res.status).toBe(200)
    expect(res.body.stipend).toBe('25.50')
    expect(await storedStipend(id)).toBe('25.50')
  })

  it('refuses a JavaScript NaN or Infinity before any insert', () => {
    expect(readStipend(Number.NaN)).toEqual({ ok: false })
    expect(readStipend(Number.POSITIVE_INFINITY)).toEqual({ ok: false })
    expect(readStipend(Number.NEGATIVE_INFINITY)).toEqual({ ok: false })
    expect(readStipend(-0)).toEqual({ ok: false })
    expect(readStipend('')).toEqual({ ok: false })
    expect(readStipend(null)).toEqual({ ok: true, value: null })
    expect(readStipend(undefined)).toEqual({ ok: true, value: null })
    expect(readStipend(0)).toEqual({ ok: true, value: '0.00' })
    expect(readStipend(10)).toEqual({ ok: true, value: '10.00' })
    expect(readStipend(10.5)).toEqual({ ok: true, value: '10.50' })
    expect(readStipend('10.50')).toEqual({ ok: true, value: '10.50' })
  })

  it('does not let another parish clear or rewrite the offering', async () => {
    const id = await withAmount(10, 'patch tenant')
    const res = await patch(id, { stipend: '' }, tokenB)
    expect(res.status).toBe(404)
    expect(await storedStipend(id)).toBe('10.00')
  })
})
