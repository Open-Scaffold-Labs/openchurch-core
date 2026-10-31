// N466-2 — public /groups must not use max-age=300 after page takedown.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import request from 'supertest'
import pool from '../src/db.js'
import { migrateOnce, bindServer, closeServer, RUN_ID } from './support/harness.js'

beforeAll(async () => { await migrateOnce() }, 180_000)

let server
beforeAll(async () => { server = await bindServer() })
afterAll(async () => { await closeServer(server); await pool.end() })

describe('N466-2 public /groups Cache-Control', () => {
  let org, slug

  beforeAll(async () => {
    const o = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, TRUE) RETURNING id, slug`,
      [`Groups Cache ${RUN_ID}`, `grp-cache-${RUN_ID}`.toLowerCase()],
    )
    org = o.rows[0]
    slug = org.slug
    await pool.query(
      `INSERT INTO ochr_groups (organization_id, name, category, description)
       VALUES ($1, 'Choir', 'ministry', 'Sings')`,
      [org.id],
    )
  })

  afterAll(async () => {
    if (!org?.id) return
    await pool.query('DELETE FROM ochr_groups WHERE organization_id = $1', [org.id]).catch(() => {})
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.id]).catch(() => {})
  })

  it('sets Cache-Control: no-store (not max-age=300)', async () => {
    const res = await request(server).get(`/api/public/${slug}/groups`)
    expect(res.status).toBe(200)
    expect(res.body.groups?.length).toBeGreaterThan(0)
    expect(res.headers['cache-control']).toMatch(/no-store/i)
    expect(res.headers['cache-control']).not.toMatch(/max-age=300/)
  })
})
