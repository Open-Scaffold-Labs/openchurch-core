// SP-176 (Saint MEM-23): a parish Viewer reads the member roster, but not a
// member's private notes or birth year. Staff and Admin read both unchanged.
// Synthetic org and members only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { signToken } from '../src/middleware/auth.js'

let server, orgId, memberId
const tokens = {}
const NOTE = `sp176 private pastoral note ${RUN_ID}`

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const res = await createOrg(server, {
    organizationName: `SP176 ${RUN_ID}`, name: 'Admin', email: `sp176_admin_${RUN_ID}@example.com`, password: 'sp176-test-pw',
  }, '10.217.6.1')
  expect(res.status).toBe(201)
  orgId = res.body.user.organization.id
  tokens.admin = res.body.token
  for (const role of ['staff', 'viewer']) {
    const email = `sp176_${role}_${RUN_ID}@example.com`
    const { rows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', $3, $4) RETURNING id, token_version`, [orgId, email, `SP176 ${role}`, role])
    tokens[role] = signToken({ userId: rows[0].id, organizationId: orgId, email, name: `SP176 ${role}`, role, tv: rows[0].token_version ?? 1 })
  }
  const { rows } = await pool.query(
    `INSERT INTO ochr_clients (organization_id, name, notes, birth_date)
     VALUES ($1, 'Eleanor Synthetic', $2, '1948-03-17') RETURNING id`, [orgId, NOTE])
  memberId = rows[0].id
}, 60_000)

afterAll(async () => {
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server); await pool.end()
})

const get = (role, path) => request(server).get(path).set('Authorization', `Bearer ${tokens[role]}`)
const find = (body) => (Array.isArray(body) ? body : []).find(r => r.id === memberId)

describe('SP-176: Viewer member reads omit notes and birth year', () => {
  it('detail: Viewer gets no notes and only month-day', async () => {
    const res = await get('viewer', `/api/clients/${memberId}`)
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Eleanor Synthetic')
    expect(res.body).not.toHaveProperty('notes')
    expect(res.body.birth_date).toBeUndefined()
    expect(res.body.birth_month_day).toBe('03-17')
    expect(JSON.stringify(res.body)).not.toContain(NOTE)
    expect(JSON.stringify(res.body)).not.toContain('1948')
  })
  it('list: Viewer gets no notes and no birth year', async () => {
    const res = await get('viewer', '/api/clients')
    expect(res.status).toBe(200)
    const row = find(res.body)
    expect(row).toBeTruthy()
    expect(row).not.toHaveProperty('notes')
    expect(row.birth_date).toBeUndefined()
    expect(row.birth_month_day).toBe('03-17')
    expect(JSON.stringify(res.body)).not.toContain(NOTE)
    expect(JSON.stringify(res.body)).not.toContain('1948')
  })
  it.each(['staff', 'admin'])('%s still reads notes and full birth date', async (role) => {
    const res = await get(role, `/api/clients/${memberId}`)
    expect(res.status).toBe(200)
    expect(res.body.notes).toBe(NOTE)
    expect(String(res.body.birth_date)).toMatch(/^1948-03-1[67]/)
    const list = find((await get(role, '/api/clients')).body)
    expect(list.notes).toBe(NOTE)
  })
  it('a demoted Viewer is scoped at once (live role, not the token)', async () => {
    const { rows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'SP176 demoted', 'viewer') RETURNING id, token_version`, [orgId, `sp176_demoted_${RUN_ID}@example.com`])
    const t = signToken({ userId: rows[0].id, organizationId: orgId, email: 'x', name: 'x', role: 'admin', tv: rows[0].token_version ?? 1 })
    const res = await request(server).get(`/api/clients/${memberId}`).set('Authorization', `Bearer ${t}`)
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('notes')
  })
})
