// OC-WEB-1 PR-A — public branding resolve + /api/public/:slug/page.
// Defaults are Parchment & Brass. Bad values never leak into the public JSON.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import request from 'supertest'
import pool from '../src/db.js'
import { migrateOnce, bindServer, closeServer, RUN_ID } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { signToken } from '../src/middleware/auth.js'
import {
  DEFAULT_ACCENT_HEX,
  resolvePublicBranding,
  isSafeHttpsLogoUrl,
  isSafeAccentHex,
} from '../src/public/branding.js'

beforeAll(async () => { await migrateOnce() }, 120_000)

let server
beforeAll(async () => { server = await bindServer() })
afterAll(async () => { await closeServer(server); await pool.end() })

describe('resolvePublicBranding (unit)', () => {
  it('defaults to Parchment & Brass when columns are null', () => {
    const b = resolvePublicBranding({
      name: 'St Brigid',
      public_display_name: null,
      public_logo_url: null,
      public_accent_hex: null,
    })
    expect(b).toEqual({
      display_name: 'St Brigid',
      logo_url: null,
      accent_hex: DEFAULT_ACCENT_HEX,
      using_defaults: true,
    })
    expect(DEFAULT_ACCENT_HEX).toBe('#5A1E23')
  })

  it('applies a safe custom display name, https logo, and #RRGGBB accent', () => {
    const b = resolvePublicBranding({
      name: 'St Brigid',
      public_display_name: '  Our Lady of the Valley  ',
      public_logo_url: 'https://cdn.example.org/crest.png',
      public_accent_hex: '#1a4f8b',
    })
    expect(b.display_name).toBe('Our Lady of the Valley')
    expect(b.logo_url).toBe('https://cdn.example.org/crest.png')
    expect(b.accent_hex).toBe('#1A4F8B')
    expect(b.using_defaults).toBe(false)
  })

  it('rejects javascript: and http: logos, and malformed accents', () => {
    expect(isSafeHttpsLogoUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeHttpsLogoUrl('http://insecure.example/x.png')).toBe(false)
    expect(isSafeHttpsLogoUrl('https://ok.example/x.png')).toBe(true)
    expect(isSafeAccentHex('#gg0000')).toBe(false)
    expect(isSafeAccentHex('5A1E23')).toBe(false)
    expect(isSafeAccentHex('#5a1e23')).toBe(true)

    const b = resolvePublicBranding({
      name: 'St Brigid',
      public_display_name: '',
      public_logo_url: 'javascript:alert(1)',
      public_accent_hex: 'red',
    })
    expect(b.display_name).toBe('St Brigid')
    expect(b.logo_url).toBe(null)
    expect(b.accent_hex).toBe(DEFAULT_ACCENT_HEX)
    expect(b.using_defaults).toBe(true)
  })

  // Argus N451-2 — cases the PR-A table omitted; validators must reject them.
  it('rejects data:, protocol-relative, userinfo, and oversize logo URLs (N451-2)', () => {
    expect(isSafeHttpsLogoUrl('data:image/png;base64,aaaa')).toBe(false)
    expect(isSafeHttpsLogoUrl('//cdn.example.org/crest.png')).toBe(false)
    expect(isSafeHttpsLogoUrl('https://user:pass@cdn.example.org/crest.png')).toBe(false)
    expect(isSafeHttpsLogoUrl('https://user@cdn.example.org/crest.png')).toBe(false)
    expect(isSafeHttpsLogoUrl('https://ok.example/' + 'a'.repeat(500))).toBe(false)

    const b = resolvePublicBranding({
      name: 'St Brigid',
      public_display_name: 'X',
      public_logo_url: 'data:text/html,<script>alert(1)</script>',
      public_accent_hex: '#1a4f8b',
    })
    expect(b.logo_url).toBe(null)
    expect(b.accent_hex).toBe('#1A4F8B')
  })
})

describe('GET /api/public/:slug/page branding', () => {
  let orgA, orgB, slugA, slugB

  beforeAll(async () => {
    const a = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published, tagline, about, service_times, address)
       VALUES ($1, $2, TRUE, 'Welcome', 'About A', 'Sun 10am', '1 A St')
       RETURNING id, slug, name`,
      [`Brand A ${RUN_ID}`, `brand-a-${RUN_ID}`.toLowerCase()],
    )
    const b = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published,
          public_display_name, public_logo_url, public_accent_hex, tagline)
       VALUES ($1, $2, TRUE, $3, $4, $5, 'Hi')
       RETURNING id, slug, name`,
      [
        `Brand B ${RUN_ID}`,
        `brand-b-${RUN_ID}`.toLowerCase(),
        'Custom Parish B',
        'https://cdn.example.org/b.png',
        '#1a4f8b',
      ],
    )
    orgA = a.rows[0]; slugA = orgA.slug
    orgB = b.rows[0]; slugB = orgB.slug
  })

  afterAll(async () => {
    for (const id of [orgA?.id, orgB?.id].filter(Boolean)) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  it('returns resolved branding defaults when the parish has set nothing', async () => {
    const res = await request(server).get(`/api/public/${slugA}/page`)
    expect(res.status).toBe(200)
    expect(res.body.branding).toEqual({
      display_name: orgA.name,
      logo_url: null,
      accent_hex: DEFAULT_ACCENT_HEX,
      using_defaults: true,
    })
    expect(res.body.church.name).toBe(orgA.name)
  })

  it('returns custom branding for the matching slug only (tenant isolation)', async () => {
    const resB = await request(server).get(`/api/public/${slugB}/page`)
    expect(resB.status).toBe(200)
    expect(resB.body.branding).toEqual({
      display_name: 'Custom Parish B',
      logo_url: 'https://cdn.example.org/b.png',
      accent_hex: '#1A4F8B',
      using_defaults: false,
    })

    const resA = await request(server).get(`/api/public/${slugA}/page`)
    expect(resA.body.branding.display_name).toBe(orgA.name)
    expect(resA.body.branding.logo_url).toBe(null)
    expect(resA.body.branding.accent_hex).toBe(DEFAULT_ACCENT_HEX)
  })

  it('migration 140 columns exist and are nullable', async () => {
    const { rows } = await pool.query(`
      SELECT column_name, is_nullable, data_type
        FROM information_schema.columns
       WHERE table_name = 'ochr_organizations'
         AND column_name IN ('public_display_name','public_logo_url','public_accent_hex')
       ORDER BY column_name`)
    expect(rows.map(r => r.column_name)).toEqual([
      'public_accent_hex', 'public_display_name', 'public_logo_url',
    ])
    expect(rows.every(r => r.is_nullable === 'YES')).toBe(true)
  })

  it('migration 141 CHECKs reject bad accent and non-https logo (N451-1)', async () => {
    const { rows: cons } = await pool.query(`
      SELECT conname FROM pg_constraint
       WHERE conname IN (
         'ochr_organizations_public_accent_hex_chk',
         'ochr_organizations_public_logo_url_chk'
       )
       ORDER BY conname`)
    expect(cons.map(r => r.conname)).toEqual([
      'ochr_organizations_public_accent_hex_chk',
      'ochr_organizations_public_logo_url_chk',
    ])

    const slug = `chk-${RUN_ID}`.toLowerCase()
    const ins = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, FALSE) RETURNING id`,
      [`CHK ${RUN_ID}`, slug],
    )
    const id = ins.rows[0].id
    try {
      await expect(pool.query(
        `UPDATE ochr_organizations SET public_accent_hex = $1 WHERE id = $2`,
        ['red', id],
      )).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query(
        `UPDATE ochr_organizations SET public_logo_url = $1 WHERE id = $2`,
        ['http://insecure.example/x.png', id],
      )).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query(
        `UPDATE ochr_organizations SET public_logo_url = $1 WHERE id = $2`,
        ['data:image/png;base64,xx', id],
      )).rejects.toMatchObject({ code: '23514' })
      // N452-1 — userinfo and oversize must fail the tight CHECK.
      await expect(pool.query(
        `UPDATE ochr_organizations SET public_logo_url = $1 WHERE id = $2`,
        ['https://user:pass@cdn.example.org/x.png', id],
      )).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query(
        `UPDATE ochr_organizations SET public_logo_url = $1 WHERE id = $2`,
        ['https://user@cdn.example.org/x.png', id],
      )).rejects.toMatchObject({ code: '23514' })
      await expect(pool.query(
        `UPDATE ochr_organizations SET public_logo_url = $1 WHERE id = $2`,
        ['https://ok.example/' + 'a'.repeat(500), id],
      )).rejects.toMatchObject({ code: '23514' })
      // Valid values still write.
      await pool.query(
        `UPDATE ochr_organizations
            SET public_accent_hex = $1, public_logo_url = $2
          WHERE id = $3`,
        ['#1a4f8b', 'https://cdn.example.org/ok.png', id],
      )
    } finally {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })
})

describe('PATCH /api/organization public branding (OC-WEB-1 PR-B)', () => {
  let token, orgId, slug, otherToken

  beforeAll(async () => {
    const a = await createOrg(server, {
      organizationName: `Brand Write ${RUN_ID}`,
      name: 'Admin Writer',
      email: `brand_write_${RUN_ID}@example.com`,
      password: 'Brand-Write-Pass-1!',
    }, '10.251.80.1')
    expect(a.status).toBe(201)
    token = a.body.token
    orgId = a.body.user.organization.id
    slug = a.body.user.organization.slug

    const b = await createOrg(server, {
      organizationName: `Brand Other ${RUN_ID}`,
      name: 'Other Admin',
      email: `brand_other_${RUN_ID}@example.com`,
      password: 'Brand-Other-Pass-1!',
    }, '10.251.80.2')
    expect(b.status).toBe(201)
    otherToken = b.body.token
  })

  it('admin can set branding; public page reflects resolved values', async () => {
    const res = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${token}`)
      .send({
        public_display_name: '  Valley Parish  ',
        public_logo_url: 'https://cdn.example.org/valley.png',
        public_accent_hex: '#1a4f8b',
        page_published: true,
      })
    expect(res.status).toBe(200)
    expect(res.body.public_display_name).toBe('Valley Parish')
    expect(res.body.public_logo_url).toBe('https://cdn.example.org/valley.png')
    expect(res.body.public_accent_hex).toBe('#1A4F8B')

    const pub = await request(server).get(`/api/public/${slug}/page`)
    expect(pub.status).toBe(200)
    expect(pub.body.branding).toEqual({
      display_name: 'Valley Parish',
      logo_url: 'https://cdn.example.org/valley.png',
      accent_hex: '#1A4F8B',
      using_defaults: false,
    })
  })

  it('rejects unsafe logo URLs and bad accents with 400', async () => {
    for (const [body, re] of [
      [{ public_logo_url: 'data:image/png;base64,xx' }, /https/i],
      [{ public_logo_url: '//cdn.example.org/x.png' }, /https/i],
      [{ public_logo_url: 'https://user:pass@cdn.example.org/x.png' }, /https|credential/i],
      [{ public_logo_url: 'http://insecure.example/x.png' }, /https/i],
      [{ public_accent_hex: 'red' }, /#RRGGBB|hex/i],
      [{ public_accent_hex: '5A1E23' }, /#RRGGBB|hex/i],
    ]) {
      const res = await request(server).patch('/api/organization')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error).toMatch(re)
    }
  })

  it('clears branding fields with empty string and stays tenant-scoped', async () => {
    const clear = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${token}`)
      .send({
        public_display_name: '',
        public_logo_url: '',
        public_accent_hex: '',
      })
    expect(clear.status).toBe(200)
    expect(clear.body.public_display_name).toBeNull()
    expect(clear.body.public_logo_url).toBeNull()
    expect(clear.body.public_accent_hex).toBeNull()

    // Other tenant cannot see or write our org — PATCH is session-scoped.
    const leak = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ public_display_name: 'Hijacked' })
    expect(leak.status).toBe(200)
    expect(leak.body.public_display_name).toBe('Hijacked')

    const ours = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${token}`)
    expect(ours.body.public_display_name).toBeNull()
    expect(ours.body.id).toBe(orgId)

    const theirs = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${otherToken}`)
    expect(theirs.body.public_display_name).toBe('Hijacked')
    expect(theirs.body.id).not.toBe(orgId)
  })

  it('staff cannot PATCH organization branding (admin RBAC)', async () => {
    const anon = await request(server).patch('/api/organization')
      .send({ public_display_name: 'Nope' })
    expect([401, 403]).toContain(anon.status)

    // Argus N452-2 — real staff JWT must 403 (mount requireRole('admin')).
    const email = `brand_staff_${RUN_ID}@example.com`
    const { rows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', $3, 'staff') RETURNING id, token_version`,
      [orgId, email, 'Brand Staff'],
    )
    const staffToken = signToken({
      userId: rows[0].id,
      organizationId: orgId,
      email,
      name: 'Brand Staff',
      role: 'staff',
      tv: rows[0].token_version ?? 1,
    })
    const staff = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ public_display_name: 'Nope' })
    expect(staff.status).toBe(403)

    const still = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${token}`)
    expect(still.body.public_display_name).not.toBe('Nope')
  })

  it('strips control characters from public_display_name (N452-3)', async () => {
    const res = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${token}`)
      .send({ public_display_name: 'Valley\u0007 Parish\u007F' })
    expect(res.status).toBe(200)
    expect(res.body.public_display_name).toBe('Valley Parish')
  })
})
