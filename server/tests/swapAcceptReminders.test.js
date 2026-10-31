// Maintenance 2026-10-24 — an accepted swap must move the serving reminder.
//
// Help promised "the schedule and reminders update themselves" after a swap.
// The accept handler rewrote assigned_to but never re-synced the event's
// queued assignment reminders, so the member who swapped OUT still got the
// reminder and the member who took the slot got none. Every other roster
// change (create, edit, rotation auto-fill) re-syncs via syncEventReminders.
//
// Synthetic fixtures on the local database only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let org
const auth = () => ({ Authorization: `Bearer ${org.token}` })

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  const name = `SwapReminders ${RUN_ID}`
  const res = await createOrg(server, { organizationName: name, name: 'Synthetic Admin', email: `swaprem_${RUN_ID}@example.com`, password: 'swap-reminders-pw-1' }, '10.97.1.1')
  expect(res.status).toBe(201)
  org = { id: res.body.user.organization.id, token: res.body.token }
}, 60000)

afterAll(async () => {
  if (org) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.id]).catch(() => {})
  await closeServer(server); await pool.end()
})

async function pendingReminderRecipients(eventId) {
  const { rows } = await pool.query(
    `SELECT recipient_email AS recipient FROM ochr_scheduled_notifications
      WHERE organization_id = $1 AND source_type = 'calendar_event' AND source_id = $2
        AND notification_type = 'assignment_reminder' AND status = 'pending'
      ORDER BY recipient_email`,
    [org.id, eventId])
  return rows.map(r => r.recipient)
}

describe('accepted swap re-syncs the event reminders', () => {
  it('reminder moves from the member who swapped out to the member who took the slot', async () => {
    const outEmail = `swap_out_${RUN_ID}@example.com`
    const inEmail  = `swap_in_${RUN_ID}@example.com`
    const a = await request(server).post('/api/clients').set(auth())
      .send({ name: `Swap Out ${RUN_ID}`, status: 'active', role: 'Member', email: outEmail })
    const b = await request(server).post('/api/clients').set(auth())
      .send({ name: `Swap In ${RUN_ID}`, status: 'active', role: 'Member', email: inEmail })
    expect(a.status).toBe(201); expect(b.status).toBe(201)

    const ev = await request(server).post('/api/calendar').set(auth())
      .send({ title: `Swap Reminder ${RUN_ID}`, date: '2027-11-07', start_time: '10:00', end_time: '11:00', type: 'service', assigned_to: [a.body.id] })
    expect(ev.status).toBe(201)
    expect(await pendingReminderRecipients(ev.body.id)).toEqual([outEmail])

    const ta = await request(server).post(`/api/swap-admin/clients/${a.body.id}/rotate-token`).set(auth())
    const tb = await request(server).post(`/api/swap-admin/clients/${b.body.id}/rotate-token`).set(auth())
    const req = await request(server).post(`/api/swap/by-token/${ta.body.swap_token}/request`)
      .send({ calendar_event_id: ev.body.id, target_client_id: b.body.id })
    expect(req.status).toBe(201)
    const acc = await request(server).post(`/api/swap/by-token/${tb.body.swap_token}/accept`)
      .send({ request_id: req.body.id })
    expect(acc.status).toBe(200)

    expect(await pendingReminderRecipients(ev.body.id)).toEqual([inEmail])
  })
})
