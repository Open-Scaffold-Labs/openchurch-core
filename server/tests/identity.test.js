// One answer to "who is this person in the roster?"
//
// ochr_users and ochr_clients describe the same human with no foreign key
// between them. The join is a case-insensitive email match, and until now it
// was written out four times in four dialects. These tests pin the predicate
// and, more importantly, pin the thing that was actually dangerous: a lookup
// failure that resolved to a confident English answer.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, app, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { memberByEmail, memberExistsByEmail, memberLanguage } from '../src/directory/memberIdentity.js'
import { languageFor } from '../src/notifications/transport.js'

let server, orgId, token, userEmail

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const signup = await request(server).post('/api/auth/signup')
    .set('X-Forwarded-For', '10.99.77.21')
    .send({
      organizationName: `Identity Parish ${RUN_ID}`,
      name: 'Identity Admin',
      email: `ident_${RUN_ID}@example.com`,
      password: 'smoke-test-pw-771',
    })
  expect(signup.status).toBe(201)
  token = signup.body.token

  const { rows } = await pool.query(
    `SELECT id, email, organization_id FROM ochr_users WHERE email = $1`,
    [`ident_${RUN_ID}@example.com`])
  expect(rows).toHaveLength(1)
  orgId = rows[0].organization_id
  userEmail = rows[0].email
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

describe('the member-identity predicate', () => {
  it('MATCHES REGARDLESS OF CASE, AND NEVER ACROSS ORGANISATIONS', async () => {
    const mixed = `MiXeD_${RUN_ID}@Example.COM`
    await pool.query(
      `INSERT INTO ochr_clients (organization_id, name, email, status)
       VALUES ($1, $2, $3, 'active')`,
      [orgId, 'Mixed Case Member', mixed])

    // Every casing of the same address is the same person.
    for (const variant of [mixed, mixed.toLowerCase(), mixed.toUpperCase()]) {
      const m = await memberByEmail(orgId, variant, ['id', 'name'])
      expect(m?.name).toBe('Mixed Case Member')
    }

    // A different parish is a different world. An email match across tenants
    // is the worst kind of correct-looking, so this is the assertion that
    // matters most in the whole file.
    const other = await pool.query(
      `INSERT INTO ochr_organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Other Parish ${RUN_ID}`, `other-parish-${RUN_ID}`])
    expect(await memberByEmail(other.rows[0].id, mixed)).toBeNull()
  })

  it('REFUSES A COLUMN THAT IS NOT ALLOWLISTED', async () => {
    // The helper interpolates column names. The allowlist is what stops a
    // future caller turning that into an injection point.
    await expect(memberByEmail(orgId, userEmail, ['password_hash']))
      .rejects.toThrow(/not allowlisted/)
    await expect(memberByEmail(orgId, userEmail, ['id; DROP TABLE ochr_clients']))
      .rejects.toThrow(/not allowlisted/)
  })

  it('RETURNS NULL RATHER THAN GUESSING ON MISSING INPUT', async () => {
    expect(await memberByEmail(null, userEmail)).toBeNull()
    expect(await memberByEmail(orgId, null)).toBeNull()
    expect(await memberExistsByEmail(orgId, `nobody_${RUN_ID}@example.com`)).toBe(false)
  })
})

describe('language resolution must not disguise its own failure', () => {
  it('RETURNS THE STATED PREFERENCE', async () => {
    const es = `spanish_${RUN_ID}@example.com`
    await pool.query(
      `INSERT INTO ochr_clients (organization_id, name, email, status, preferred_language)
       VALUES ($1, $2, $3, 'active', 'es')`,
      [orgId, 'Prefiere Español', es])
    expect(await languageFor({ organizationId: orgId, recipient: es })).toBe('es')
  })

  it('RETURNS ENGLISH WHEN NO PREFERENCE IS STATED', async () => {
    const none = `nopref_${RUN_ID}@example.com`
    await pool.query(
      `INSERT INTO ochr_clients (organization_id, name, email, status)
       VALUES ($1, $2, $3, 'active')`,
      [orgId, 'No Preference', none])
    expect(await languageFor({ organizationId: orgId, recipient: none })).toBe('en')
  })

  it('STILL RETURNS ENGLISH WHEN THE LOOKUP FAILS — BUT SAYS SO', async () => {
    // This is the defect. Before, a query failure and "this person has stated
    // no preference" produced the same value and the same silence: a
    // Spanish-speaking parishioner receiving English, indistinguishable from
    // one who never asked for Spanish. The fallback is correct — a
    // notification must not fail over a preference lookup — but it must not
    // be silent.
    const { monitor } = await import('../src/monitoring/index.js')
    const spy = vi.spyOn(monitor, 'error').mockImplementation(() => {})
    const boom = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('connection reset'))
    try {
      const lang = await languageFor({
        organizationId: orgId, recipient: `whoever_${RUN_ID}@example.com` })
      expect(lang).toBe('en')                       // still safe
      expect(spy).toHaveBeenCalledTimes(1)          // and no longer silent
      expect(spy.mock.calls[0][0]).toBe('notify.language_lookup')
    } finally {
      boom.mockRestore(); spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// The language lookup, and the two ways dropping one predicate breaks it.
//
// Added 27 Aug after an audit found that 71e49ba replaced the language query
// with a generic memberByEmail() call, silently deleting
// `AND preferred_language IS NOT NULL`. Both tests below were falsified by
// reverting memberLanguage() to the predicate-free form and observing them
// fail.
// ---------------------------------------------------------------------------

describe('memberLanguage', () => {
  it('keeps migration 095\'s partial index usable', async () => {
    // WHAT WOULD MAKE THIS FAIL: removing `AND preferred_language IS NOT NULL`
    // from memberLanguage(). Postgres uses a PARTIAL index only when the
    // query predicate implies the index predicate, so without it this
    // becomes a sequential scan over every member in every tenant.
    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_clients_org_lower_email_lang'`)
    expect(idx.rows).toHaveLength(1)
    expect(idx.rows[0].indexdef).toMatch(/WHERE .*preferred_language IS NOT NULL/i)

    await pool.query(
      `INSERT INTO ochr_clients (organization_id, name, email, preferred_language)
       SELECT $1, 'Plan Probe ' || g, 'planprobe' || g || $2,
              CASE WHEN g % 50 = 0 THEN 'es' ELSE NULL END
         FROM generate_series(1, 2000) g`, [orgId, `_${RUN_ID}@example.com`])
    await pool.query('ANALYZE ochr_clients')

    // Capture the SQL memberLanguage ACTUALLY emits, rather than retyping a
    // query here. The first version of this test EXPLAINed a hand-written
    // string and stayed green while the module's own predicate was removed —
    // it proved nothing about the implementation. Falsified 27 Aug.
    let emitted = null
    const spy = { query: (text, params) => { emitted = text; return pool.query(text, params) } }
    await memberLanguage(orgId, `planprobe1999_${RUN_ID}@example.com`, spy)
    expect(emitted).toBeTruthy()

    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON) ${emitted}`,
      [orgId, `planprobe1999_${RUN_ID}@example.com`])

    const plan = JSON.stringify(rows[0]['QUERY PLAN'])
    expect(plan).toContain('idx_clients_org_lower_email_lang')
    expect(plan).not.toContain('Seq Scan')
  }, 60_000)

  it('returns the stated preference even when a duplicate row has none', async () => {
    // WHAT WOULD MAKE THIS FAIL: dropping the predicate. There is no unique
    // constraint on (organization_id, email), so `LIMIT 1` with no ORDER BY
    // may return either duplicate. Only the predicate guarantees the row
    // that actually carries a preference is the one we read.
    // PRODUCTION-SHAPED, deliberately. The first version of this test wrote
    // an explicit NULL — a value no insert path in this codebase produces,
    // because preferred_language is TEXT DEFAULT 'en'. It therefore passed
    // against a fixture that could not occur. The duplicate below is what
    // connect.js's race actually creates: two rows, both defaulted to 'en',
    // one of which a secretary later set to Spanish.
    const dupe = `dupe_${RUN_ID}@example.com`
    await pool.query(
      `INSERT INTO ochr_clients (organization_id, name, email)
       VALUES ($1, 'Maria (never asked)', $2), ($1, 'Maria (asked for Spanish)', $2)`,
      [orgId, dupe])
    const both = await pool.query(
      `SELECT id, preferred_language FROM ochr_clients WHERE email = $1 ORDER BY id`, [dupe])
    expect(both.rows.map(r => r.preferred_language)).toEqual(['en', 'en'])  // the default did apply
    await pool.query(
      `UPDATE ochr_clients SET preferred_language = 'es' WHERE id = $1`, [both.rows[1].id])

    expect(await memberLanguage(orgId, dupe)).toBe('es')
    expect(await languageFor({ organizationId: orgId, recipient: dupe })).toBe('es')

    // Touch the default row so the heap hands it back first, then ask again.
    // Without the ORDER BY tie-break this answers 'en'; it must not.
    await pool.query(
      `UPDATE ochr_clients SET name = name || ' ' WHERE id = $1`, [both.rows[0].id])
    expect(await memberLanguage(orgId, dupe)).toBe('es')
    expect(await languageFor({ organizationId: orgId, recipient: dupe })).toBe('es')
  }, 60_000)

  it('does not depend on membership status', async () => {
    // SURVIVING MUTANT, found by an auditor 27 Aug: adding
    // `AND status = 'active'` to the query passed all nine tests, because
    // every fixture row took the column default. An inactive or new member
    // who asked for Spanish is still a person who asked for Spanish.
    for (const status of ['inactive', 'new']) {
      const addr = `status_${status}_${RUN_ID}@example.com`
      await pool.query(
        `INSERT INTO ochr_clients (organization_id, name, email, preferred_language, status)
         VALUES ($1, 'Status Probe', $2, 'es', $3)`, [orgId, addr, status])
      expect(await memberLanguage(orgId, addr)).toBe('es')
      expect(await languageFor({ organizationId: orgId, recipient: addr })).toBe('es')
    }
  }, 60_000)

  it('returns every stated preference, not only Spanish', async () => {
    // SURVIVING MUTANT: narrowing the predicate to `= 'es'` passed all nine
    // tests, because languageFor() collapses everything that is not 'es' to
    // 'en' and no test looked at memberLanguage's own contract. It is a
    // shared helper — the next caller may not collapse.
    const cases = [['en', 'en'], ['es', 'es'], ['both', 'both']]
    for (const [stored, expected] of cases) {
      const addr = `pref_${stored}_${RUN_ID}@example.com`
      await pool.query(
        `INSERT INTO ochr_clients (organization_id, name, email, preferred_language)
         VALUES ($1, 'Pref Probe', $2, $3)`, [orgId, addr, stored])
      expect(await memberLanguage(orgId, addr)).toBe(expected)
    }
    expect(await languageFor({ organizationId: orgId, recipient: `pref_both_${RUN_ID}@example.com` })).toBe('en')
  }, 60_000)

  it('is still case-insensitive and tenant-scoped', async () => {
    const addr = `lang_${RUN_ID}@example.com`
    await pool.query(
      `INSERT INTO ochr_clients (organization_id, name, email, preferred_language)
       VALUES ($1, 'Case Probe', $2, 'es')`, [orgId, addr])
    expect(await memberLanguage(orgId, addr.toUpperCase())).toBe('es')
    expect(await memberLanguage(orgId + 99999, addr)).toBeNull()
  }, 60_000)
})
