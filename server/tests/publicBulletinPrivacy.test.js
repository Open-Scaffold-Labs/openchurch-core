// SP-299 — public bulletin AND-gate: page_published && bulletin.published.
// Same 404 for every denied path; Cache-Control: no-store; no body leak.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import request from 'supertest'
import pool from '../src/db.js'
import { migrateOnce, bindServer, closeServer, RUN_ID } from './support/harness.js'

beforeAll(async () => { await migrateOnce() }, 180_000)

let server
beforeAll(async () => { server = await bindServer() })
afterAll(async () => { await closeServer(server); await pool.end() })

describe('SP-299 public bulletin privacy', () => {
  let orgOn, orgOff, orgHeld, orgFlip, slugOn, slugOff, slugHeld, slugFlip

  beforeAll(async () => {
    const on = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, TRUE) RETURNING id, slug`,
      [`Bul On ${RUN_ID}`, `bul-on-${RUN_ID}`.toLowerCase()],
    )
    const off = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, FALSE) RETURNING id, slug`,
      [`Bul Off ${RUN_ID}`, `bul-off-${RUN_ID}`.toLowerCase()],
    )
    const held = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, TRUE) RETURNING id, slug`,
      [`Bul Held ${RUN_ID}`, `bul-held-${RUN_ID}`.toLowerCase()],
    )
    const flip = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, TRUE) RETURNING id, slug`,
      [`Bul Flip ${RUN_ID}`, `bul-flip-${RUN_ID}`.toLowerCase()],
    )
    orgOn = on.rows[0]
    orgOff = off.rows[0]
    orgHeld = held.rows[0]
    orgFlip = flip.rows[0]
    slugOn = orgOn.slug
    slugOff = orgOff.slug
    slugHeld = orgHeld.slug
    slugFlip = orgFlip.slug

    // Published bulletin on page-off org (Saint reproduction).
    await pool.query(
      `INSERT INTO ochr_bulletins
         (organization_id, date, title, announcements, readings, intentions, pastor_note, published)
       VALUES ($1, '2026-11-01', 'All Saints', 'Parish news', 'Wis 3:1',
               '† Joseph Testwalker — Teresa Testwalker (SP-299 probe)', 'Peace', TRUE)`,
      [orgOff.id],
    )
    // Draft-only on page-on org.
    await pool.query(
      `INSERT INTO ochr_bulletins
         (organization_id, date, announcements, readings, intentions, pastor_note, published)
       VALUES ($1, '2026-11-08', 'Draft only', 'x', 'y', 'z', FALSE)`,
      [orgOn.id],
    )
    // Published bulletin on held org (N469-3 held_at gate).
    await pool.query(
      `INSERT INTO ochr_bulletins
         (organization_id, date, announcements, readings, intentions, pastor_note, published)
       VALUES ($1, '2026-11-01', 'Held parish news', 'Heb 1',
               '† Held Deceased — Held Requester', 'Held note', TRUE)`,
      [orgHeld.id],
    )
    await pool.query(
      `UPDATE ochr_organizations SET held_at = NOW() WHERE id = $1`,
      [orgHeld.id],
    )
    // Published bulletin for transition flips (N469-3).
    await pool.query(
      `INSERT INTO ochr_bulletins
         (organization_id, date, announcements, readings, intentions, pastor_note, published)
       VALUES ($1, '2026-11-15', 'Flip news', 'Rom 8', 'For the living', 'Flip note', TRUE)`,
      [orgFlip.id],
    )
  })

  afterAll(async () => {
    for (const id of [orgOn?.id, orgOff?.id, orgHeld?.id, orgFlip?.id].filter(Boolean)) {
      await pool.query('DELETE FROM ochr_bulletins WHERE organization_id = $1', [id]).catch(() => {})
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  it('Gate A alone: page_published=false + published bulletin → 404 (Saint reproduction)', async () => {
    const res = await request(server).get(`/api/public/${slugOff}/bulletin`)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Bulletin not found' })
    expect(JSON.stringify(res.body)).not.toMatch(/Joseph|Teresa|Testwalker|Parish news|Peace/i)
    expect(res.headers['cache-control']).toMatch(/no-store/i)
  })

  it('Gate B alone: page_published=true + draft-only → 404', async () => {
    const res = await request(server).get(`/api/public/${slugOn}/bulletin`)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Bulletin not found' })
    expect(JSON.stringify(res.body)).not.toMatch(/Draft only/i)
  })

  it('Both gates true → 200 with bulletin; no-store', async () => {
    await pool.query(
      `INSERT INTO ochr_bulletins
         (organization_id, date, announcements, readings, intentions, pastor_note, published)
       VALUES ($1, '2026-11-01', 'Live news', 'Heb 11', 'For the parish', 'Grace', TRUE)`,
      [orgOn.id],
    )
    const res = await request(server).get(`/api/public/${slugOn}/bulletin`)
    expect(res.status).toBe(200)
    expect(res.body.bulletin.announcements).toBe('Live news')
    expect(res.body.bulletin.intentions).toBe('For the parish')
    expect(res.headers['cache-control']).toMatch(/no-store/i)
    expect(res.headers['cache-control']).not.toMatch(/max-age=300/)
  })

  it('Unknown slug → same 404 shape (no leak)', async () => {
    const res = await request(server).get('/api/public/no-such-parish-zzz/bulletin')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Bulletin not found' })
  })

  it('N469-3 held_at alone: held org + page_published + published bulletin → 404 (no leak)', async () => {
    const res = await request(server).get(`/api/public/${slugHeld}/bulletin`)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Bulletin not found' })
    expect(JSON.stringify(res.body)).not.toMatch(/Held parish|Held Deceased|Held Requester|Held note/i)
    expect(res.headers['cache-control']).toMatch(/no-store/i)
  })

  it('N469-3 transition: unpublish bulletin → 404; re-publish → 200', async () => {
    const live = await request(server).get(`/api/public/${slugFlip}/bulletin`)
    expect(live.status).toBe(200)
    expect(live.body.bulletin.announcements).toBe('Flip news')

    await pool.query(
      `UPDATE ochr_bulletins SET published = FALSE
        WHERE organization_id = $1 AND date = '2026-11-15'`,
      [orgFlip.id],
    )
    const down = await request(server).get(`/api/public/${slugFlip}/bulletin`)
    expect(down.status).toBe(404)
    expect(down.body).toEqual({ error: 'Bulletin not found' })
    expect(JSON.stringify(down.body)).not.toMatch(/Flip news|Flip note/i)

    await pool.query(
      `UPDATE ochr_bulletins SET published = TRUE
        WHERE organization_id = $1 AND date = '2026-11-15'`,
      [orgFlip.id],
    )
    const up = await request(server).get(`/api/public/${slugFlip}/bulletin`)
    expect(up.status).toBe(200)
    expect(up.body.bulletin.announcements).toBe('Flip news')
    expect(up.headers['cache-control']).toMatch(/no-store/i)
  })

  it('N469-3 transition: page_published false → 404; restore → 200', async () => {
    const live = await request(server).get(`/api/public/${slugFlip}/bulletin`)
    expect(live.status).toBe(200)

    await pool.query(
      `UPDATE ochr_organizations SET page_published = FALSE WHERE id = $1`,
      [orgFlip.id],
    )
    const down = await request(server).get(`/api/public/${slugFlip}/bulletin`)
    expect(down.status).toBe(404)
    expect(down.body).toEqual({ error: 'Bulletin not found' })
    expect(JSON.stringify(down.body)).not.toMatch(/Flip news|For the living|Flip note/i)

    await pool.query(
      `UPDATE ochr_organizations SET page_published = TRUE WHERE id = $1`,
      [orgFlip.id],
    )
    const up = await request(server).get(`/api/public/${slugFlip}/bulletin`)
    expect(up.status).toBe(200)
    expect(up.body.bulletin.intentions).toBe('For the living')
  })
})
