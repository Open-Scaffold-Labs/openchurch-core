// Login closure must not cancel queued mail addressed to a member or donor
// RECORD that shares the closed login's address (CAROLINA-423-R2 known gap,
// #293 F1 class). #423 added the record-addressed type filter for
// self-serve deletion; closure (self and admin) still cancelled, e.g., a
// queued donation_receipt with "cancelled: login closed". Red on main,
// green with the fix. Rows addressed to the login's id, and login-addressed
// types matched by address, are still cancelled. Synthetic local data only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'

let server
let ipN = 1
const ip = () => `10.98.${Math.floor(ipN / 200)}.${(ipN++ % 200) + 1}`
const auth = (t) => ({ Authorization: `Bearer ${t}` })
const PW = 'crq-pw-123456'
const em = (t) => `crq_${t}_${RUN_ID}@example.com`

async function one(sql, params) {
  const { rows } = await pool.query(sql, params)
  return rows[0] || null
}

async function signup(tag) {
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', ip())
    .send({ organizationName: `CRQ ${tag} ${RUN_ID}`, name: `Fic Admin ${tag}`, email: em(tag), password: PW })
  expect(res.status).toBe(201)
  return { token: res.body.token, id: res.body.user.id, org: res.body.user.organization.id }
}

async function addUser(adm, tag) {
  const u = await request(server).post('/api/users').set(auth(adm.token))
    .send({ name: `Fic ${tag}`, email: em(tag), password: PW, role: 'staff' })
  expect(u.status).toBe(201)
  const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', ip())
    .send({ email: em(tag), password: PW })
  expect(l.status).toBe(200)
  return { token: l.body.token, id: u.body.id, org: adm.org, email: em(tag) }
}

async function queue(org, u) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_scheduled_notifications
       (organization_id, user_id, recipient_email, notification_type, send_at)
     VALUES ($1, NULL, $2, 'donation_receipt', NOW() + INTERVAL '1 day'),
            ($1, NULL, $2, 'recurring_gift_stopped', NOW() + INTERVAL '1 day'),
            ($1, NULL, $2, 'task_due_reminder', NOW() + INTERVAL '1 day'),
            ($1, $3, $2, 'donation_receipt', NOW() + INTERVAL '1 day')
     RETURNING id`,
    [org, u.email.toUpperCase(), u.id])
  return rows.map(r => r.id)
}

const status = async (id) => (await one('SELECT status, error FROM ochr_scheduled_notifications WHERE id = $1', [id]))

function expectFiltered(s) {
  // record-addressed, matched by address only: kept
  expect(s[0].status).toBe('pending')
  expect(s[1].status).toBe('pending')
  // login-addressed type matched by address: cancelled
  expect(s[2]).toMatchObject({ status: 'cancelled', error: 'cancelled: login closed' })
  // addressed to this login's id: cancelled whatever its type
  expect(s[3]).toMatchObject({ status: 'cancelled', error: 'cancelled: login closed' })
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
})

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

describe('closure leaves record-addressed queued mail alone', () => {
  it('self-close', async () => {
    const a = await signup('self')
    const u = await addUser(a, 'selfu')
    const ids = await queue(a.org, u)
    const r = await request(server).post('/api/auth/close').set(auth(u.token)).send({})
    expect(r.status).toBe(200)
    expectFiltered(await Promise.all(ids.map(status)))
  })

  it('admin close', async () => {
    const a = await signup('adm')
    const u = await addUser(a, 'admu')
    const ids = await queue(a.org, u)
    const r = await request(server).post(`/api/users/${u.id}/close`).set(auth(a.token)).send({})
    expect(r.status).toBe(200)
    expectFiltered(await Promise.all(ids.map(status)))
  })
})
