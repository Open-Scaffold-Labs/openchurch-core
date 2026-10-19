import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { holdOrganization } from '../src/auth/organizationHold.js'

let server
const orgIds = []
let sequence = 1
const auth = token => ({ Authorization: `Bearer ${token}` })
beforeAll(async () => { await migrateOnce(); server = await bindServer() }, 60000)
afterAll(async () => {
  for (const id of orgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id])
    expect((await pool.query('SELECT id FROM ochr_organizations WHERE id = $1', [id])).rows).toHaveLength(0)
  }
  await closeServer(server); await pool.end()
})
async function parish(tag) {
  const name = `Lifecycle ${tag} ${RUN_ID}`
  const email = `profile_${tag}_${RUN_ID}@example.com`
  const response = await createOrg(server, { organizationName: name, name: 'Synthetic Admin', email, password: 'profile-test-pw' }, `10.92.${sequence++}.1`)
  expect(response.status).toBe(201)
  const id = response.body.user.organization.id
  orgIds.push(id)
  return { id, name, email, userId: response.body.user.id, token: response.body.token }
}
async function profile(org) {
  const r = await request(server).post('/api/clients').set(auth(org.token)).send({ name: 'Synthetic Person', email: `person_${org.id}@example.com`, phone: '5550100', notes: 'Synthetic private note', avatar: 'synthetic.png', birth_date: '1990-01-01' })
  expect(r.status).toBe(201)
  return r.body.id
}
const confirmation = { confirm: 'DEIDENTIFY', acknowledge_history_retained: true }

describe('profile minimization', () => {
  it('refuses staff and viewers on both profile minimization and organization hold', async () => {
    const org = await parish('roles')
    const id = await profile(org)
    for (const role of ['staff', 'viewer']) {
      const email = `${role}_profile_${RUN_ID}@example.com`
      expect((await request(server).post('/api/users').set(auth(org.token)).send({ name: 'Synthetic Operator', email, password: 'profile-test-pw', role })).status).toBe(201)
      const login = await request(server).post('/api/auth/login').send({ email, password: 'profile-test-pw' })
      expect(login.status).toBe(200)
      expect((await request(server).post(`/api/clients/${id}/deidentify`).set(auth(login.body.token)).send(confirmation)).status).toBe(403)
      expect((await request(server).post('/api/organization/hold').set(auth(login.body.token)).send({ confirm: org.name, acknowledge_export_warning: true })).status).toBe(403)
    }
  })
  it('requires explicit confirmation, clears contact data, preserves stable identity and canonical history without vault capture', async () => {
    const org = await parish('profile')
    const id = await profile(org)
    await pool.query('UPDATE ochr_clients SET calendar_token = $1, swap_token = $4 WHERE id = $2 AND organization_id = $3', ['synthetic-calendar', id, org.id, 'synthetic-swap'])
    await pool.query(`INSERT INTO ochr_sacramental_records (organization_id, client_id, type, date, minister, place, member_name) VALUES ($1, $2, 'baptism', '2020-01-01', 'Synthetic Minister', 'Synthetic Chapel', 'Synthetic Person')`, [org.id, id])
    const { rows: [gift] } = await pool.query(`INSERT INTO ochr_donations (organization_id, donor_name, amount) VALUES ($1, 'Synthetic Person', 20) RETURNING id`, [org.id])
    await pool.query(`INSERT INTO ochr_giving_statements (organization_id, tax_year, donor_key, donor_key_kind, statement_no, issue_key, status, snapshot_version, snapshot_json, issued_by, issued_by_name) VALUES ($1, 2026, $2, 'email', $3, $4, 'issued', 1, $5::jsonb, $6, 'Synthetic Admin')`, [org.id, `person_${org.id}@example.com`, `GS-PROFILE-${org.id}-${RUN_ID}`, `profile-${org.id}-${RUN_ID}`, JSON.stringify({ donor: { name: 'Synthetic Person' }, total: 20 }), org.userId])
    const { rows: [event] } = await pool.query(`INSERT INTO ochr_calendar_events (organization_id, title, date, start_time, end_time) VALUES ($1, 'Synthetic service', CURRENT_DATE, '09:00', '10:00') RETURNING id`, [org.id])
    await pool.query(`INSERT INTO ochr_checkins (organization_id, calendar_event_id, client_id, person_name) VALUES ($1, $2, $3, 'Synthetic Person')`, [org.id, event.id, id])
    await pool.query(`INSERT INTO ochr_mass_intentions (organization_id, intention, requested_by, requested_by_client_id) VALUES ($1, 'Synthetic intention', 'Synthetic Person', $2)`, [org.id, id])
    await pool.query('UPDATE ochr_organizations SET kiosk_token = $1 WHERE id = $2', [`synthetic-kiosk-token-${org.id}`, org.id])
    const vaultCount = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM ochr_vault_entries WHERE organization_id = $1', [org.id])).rows[0].n
    const before = await vaultCount()
    const kioskBefore = await request(server).get(`/api/kiosk/synthetic-kiosk-token-${org.id}/members?q=Synthetic%20Person`)
    expect(kioskBefore.body.members.map(m => m.id)).toContain(id)
    expect((await request(server).post(`/api/clients/${id}/deidentify`).set(auth(org.token)).send({})).status).toBe(400)
    const result = await request(server).post(`/api/clients/${id}/deidentify`).set(auth(org.token)).send(confirmation)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ deidentified: true, parish_history_retained: true, all_copies_erased: false })
    const { rows: [row] } = await pool.query('SELECT * FROM ochr_clients WHERE id = $1 AND organization_id = $2', [id, org.id])
    expect(row).toMatchObject({ id, name: 'Synthetic Person', email: null, phone: null, notes: null, avatar: null, birth_date: null, calendar_token: null, swap_token: null, status: 'inactive' })
    expect(row.deidentified_at).not.toBeNull()
    expect((await pool.query('SELECT member_name FROM ochr_sacramental_records WHERE client_id = $1 AND organization_id = $2', [id, org.id])).rows[0].member_name).toBe('Synthetic Person')
    expect((await pool.query('SELECT donor_name, amount FROM ochr_donations WHERE id = $1 AND organization_id = $2', [gift.id, org.id])).rows[0]).toEqual({ donor_name: 'Synthetic Person', amount: expect.anything() })
    expect((await pool.query('SELECT snapshot_json FROM ochr_giving_statements WHERE organization_id = $1 AND issue_key = $2', [org.id, `profile-${org.id}-${RUN_ID}`])).rows[0].snapshot_json).toEqual({ donor: { name: 'Synthetic Person' }, total: 20 })
    expect((await pool.query('SELECT person_name FROM ochr_checkins WHERE client_id = $1 AND organization_id = $2', [id, org.id])).rows[0].person_name).toBe('Synthetic Person')
    expect((await pool.query('SELECT intention, requested_by FROM ochr_mass_intentions WHERE requested_by_client_id = $1 AND organization_id = $2', [id, org.id])).rows[0]).toEqual({ intention: 'Synthetic intention', requested_by: 'Synthetic Person' })
    const kiosk = await request(server).get(`/api/kiosk/synthetic-kiosk-token-${org.id}/members?q=Synthetic`)
    expect(kiosk.status).toBe(200)
    expect(kiosk.body.members).toEqual([])
    expect(await vaultCount()).toBe(before)
    expect((await request(server).get('/api/calendar-sync/synthetic-calendar.ics')).status).toBe(404)
    expect((await request(server).post(`/api/clients/${id}/deidentify`).set(auth(org.token)).send(confirmation)).body.already).toBe(true)
  })
  it('rejects cross-tenant use and stale edits; database guard prevents direct reidentification and old snapshot reinsert', async () => {
    const org = await parish('guard'), other = await parish('other')
    const id = await profile(org)
    expect((await request(server).post(`/api/clients/${id}/deidentify`).set(auth(other.token)).send(confirmation)).status).toBe(404)
    expect((await request(server).post(`/api/clients/${id}/deidentify`).set(auth(org.token)).send(confirmation)).status).toBe(200)
    expect((await request(server).patch(`/api/clients/${id}`).set(auth(org.token)).send({ email: 'restored@example.com' })).status).toBe(409)
    await expect(pool.query('UPDATE ochr_clients SET email = $1 WHERE id = $2 AND organization_id = $3', ['restored@example.com', id, org.id])).rejects.toMatchObject({ code: '23514' })
    await pool.query('DELETE FROM ochr_clients WHERE id = $1 AND organization_id = $2', [id, org.id])
    await expect(pool.query(`INSERT INTO ochr_clients (id, organization_id, name, email, status) VALUES ($1, $2, 'Synthetic Person', 'old@example.com', 'active')`, [id, org.id])).rejects.toMatchObject({ code: '23514' })
  })
})

describe('organization hold', () => {
  it('waits for pending user admission, then disables the admitted user and refuses post-hold capability writes', async () => {
    const org = await parish('hold_race')
    const writer = await pool.connect()
    let holdPromise
    try {
      await writer.query('BEGIN')
      const { rows: [backend] } = await writer.query('SELECT pg_backend_pid() AS pid')
      const { rows: [admitted] } = await writer.query(`INSERT INTO ochr_users (organization_id, name, email, password_hash, role) SELECT $1, 'Synthetic New Staff', $2, password_hash, 'staff' FROM ochr_users WHERE id = $3 RETURNING id`, [org.id, `pending_${org.id}_${RUN_ID}@example.com`, org.userId])
      let finished = false
      holdPromise = holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true }).then(result => { finished = true; return result })
      let blocked = false
      for (let attempt = 0; attempt < 20 && !blocked; attempt++) {
        const { rows: [waiting] } = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked`, [backend.pid])
        blocked = waiting.blocked
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(blocked).toBe(true)
      expect(finished).toBe(false)
      await writer.query('COMMIT')
      expect((await holdPromise).status).toBe(200)
      expect((await pool.query('SELECT deactivated_at FROM ochr_users WHERE id = $1 AND organization_id = $2', [admitted.id, org.id])).rows[0].deactivated_at).not.toBeNull()
      await expect(pool.query('UPDATE ochr_users SET deactivated_at = NULL WHERE id = $1 AND organization_id = $2', [admitted.id, org.id])).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query(`INSERT INTO ochr_users (organization_id, name, email, password_hash, role) VALUES ($1, 'Synthetic Late Staff', $2, 'unusable', 'staff')`, [org.id, `late_${org.id}_${RUN_ID}@example.com`])).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query(`INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`, [admitted.id, `synthetic-held-${org.id}-${RUN_ID}`])).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query('UPDATE ochr_organizations SET held_at = NULL WHERE id = $1', [org.id])).rejects.toMatchObject({ code: '23514' })
    } finally {
      await writer.query('ROLLBACK').catch(() => {})
      writer.release()
      if (holdPromise) await holdPromise
    }
  })
  it('requires named confirmation and export warning, stops stale access, retains parish data and rejects late writes', async () => {
    const org = await parish('hold'), other = await parish('hold_other')
    const id = await profile(org)
    await pool.query(`INSERT INTO ochr_donations (organization_id, donor_name, amount) VALUES ($1, 'Synthetic Person', 20)`, [org.id])
    const donationsBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM ochr_donations WHERE organization_id = $1', [org.id])).rows[0].n
    expect((await request(server).post('/api/organization/hold').set(auth(org.token)).send({ confirm: 'wrong', acknowledge_export_warning: true })).status).toBe(400)
    const result = await request(server).post('/api/organization/hold').set(auth(org.token)).send({ confirm: org.name, acknowledge_export_warning: true })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ held: true, organization_deleted: false, all_copies_erased: false, provider_status: 'not_contacted' })
    expect((await request(server).patch(`/api/clients/${id}`).set(auth(org.token)).send({ notes: 'stale' })).status).toBe(401)
    await expect(pool.query('UPDATE ochr_clients SET notes = $1 WHERE id = $2 AND organization_id = $3', ['late write', id, org.id])).rejects.toMatchObject({ code: '23514' })
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM ochr_donations WHERE organization_id = $1', [org.id])).rows[0].n).toBe(donationsBefore)
    expect((await pool.query('SELECT closed_at, deactivated_at FROM ochr_users WHERE organization_id = $1', [org.id])).rows[0]).toMatchObject({ closed_at: null, deactivated_at: expect.any(Date) })
    expect((await request(server).get('/api/organization').set(auth(other.token))).status).toBe(200)
  })
})
