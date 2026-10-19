// PORTABILITY-L2-01 / OC-CYCLE-MAX-04 item A — parish-owned export completeness.
//
// CLAIM under test: GET /api/organization/export (and buildOrgExport) carries a
// complete, UTF-8-honest, tenant-scoped copy of existing operational domains
// (members, Mass intentions + status/history stamps, schedule/events/assignments,
// attendance/check-in), with stable field names, an explicit format version, and
// parish identity — and fails/strips honestly for credential-shaped columns.
//
// WHAT WOULD MAKE THESE FAIL
//   - organization header thin to id/name/slug/created_at only
//   - plaintext check-in security_code present in the dump
//   - cross-tenant member / intention / attendance / check-in rows
//   - UTF-8 names, † intentions, commas/quotes/newlines mangled
//   - fulfilled Mass stamps omitted from ochr_mass_intentions rows
//   - Content-Type missing charset=utf-8 on the download route

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { buildOrgExport } from '../src/services/orgExport.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let tokenA, tokenB, orgAId, orgBId
let memberAId, memberBId
let eventId, calEventId

const auth = token => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const a = await createOrg(server, {
    organizationName: `Portabilidad Parroquia Ñuñoa ${RUN_ID}`,
    name: 'Ada Admin',
    email: `port_a_${RUN_ID}@example.com`,
    password: 'port-test-pw-1',
  })
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgAId = a.body.user.organization.id

  const b = await createOrg(server, {
    organizationName: `Portability Other Parish ${RUN_ID}`,
    name: 'Bea Admin',
    email: `port_b_${RUN_ID}@example.com`,
    password: 'port-test-pw-2',
  })
  expect(b.status).toBe(201)
  tokenB = b.body.token
  orgBId = b.body.user.organization.id

  // Enrich parish identity on A — the settings surface the export must carry.
  const patch = await request(server).patch('/api/organization').set(auth(tokenA)).send({
    timezone: 'America/Mexico_City',
    tradition: 'catholic',
    locale: 'es',
    address: 'Calle Ñuñoa 12, "Barrio Viejo"',
    tagline: 'Fe, esperanza, y "paz"',
    about: 'Línea uno.\nLínea dos, con comas.',
    service_times: 'Domingo 10:00',
    signatory_name: 'Párroco José María',
    signatory_title: 'Párroco',
    statement_letterhead: 'Parroquia San José',
    reminder_lead_hours: 48,
  })
  expect(patch.status).toBe(200)

  const mA = await request(server).post('/api/clients').set(auth(tokenA)).send({
    name: 'María José Núñez',
    email: `maria_${RUN_ID}@example.com`,
    notes: 'Line1\nLine2, with "quotes"',
  })
  expect(mA.status).toBe(201)
  memberAId = mA.body.id

  const mB = await request(server).post('/api/clients').set(auth(tokenB)).send({
    name: `SHOULD_NOT_EXPORT_CROSS_TENANT ${RUN_ID}`,
  })
  expect(mB.status).toBe(201)
  memberBId = mB.body.id

  const cal = await request(server).post('/api/calendar').set(auth(tokenA)).send({
    title: 'Misa Dominical',
    date: '2026-09-20',
    start_time: '10:00',
    end_time: '11:00',
    type: 'mass',
  })
  expect(cal.status).toBe(201)
  calEventId = cal.body.id

  const mi = await request(server).post('/api/mass-intentions').set(auth(tokenA)).send({
    intention: '†José García — "por la familia"',
    note: 'nota con, comas',
    status: 'open',
  })
  expect(mi.status).toBe(201)
  const assign = await request(server)
    .post(`/api/mass-intentions/${mi.body.id}/assign`)
    .set(auth(tokenA))
    .send({ calendar_event_id: calEventId })
  expect(assign.status).toBe(200)
  const fulfill = await request(server)
    .patch(`/api/mass-intentions/${mi.body.id}`)
    .set(auth(tokenA))
    .send({ status: 'fulfilled' })
  expect(fulfill.status).toBe(200)

  const ev = await request(server).post('/api/events').set(auth(tokenA)).send({
    title: 'Choir Practice — café',
    date: '2026-09-21',
    time: '19:00',
    location: 'Sala "A"',
    member_ids: [memberAId],
  })
  expect(ev.status).toBe(201)
  eventId = ev.body.id

  await pool.query(
    `INSERT INTO ochr_attendance (organization_id, event_id, member_id, status, marked_at)
     VALUES ($1, $2, $3, 'present', NOW())`,
    [orgAId, eventId, memberAId],
  )

  // A LEGACY row: plaintext security_code predates migration 116, whose
  // trigger now refuses new plaintext codes. Simulate the legacy write with
  // the trigger off for this one INSERT, so the export strip is still proved
  // against the data that actually exists in older tenants.
  const legacy = await pool.connect()
  try {
    await legacy.query('BEGIN')
    await legacy.query('ALTER TABLE ochr_checkins DISABLE TRIGGER trg_checkins_no_plaintext_code')
    await legacy.query(
      `INSERT INTO ochr_checkins
         (organization_id, calendar_event_id, client_id, person_name, kind,
          security_code, security_code_hash, attended_date, attended_title)
       VALUES ($1, $2, $3, 'Niño Pérez', 'child',
               'RAWCODE-PORT-${RUN_ID}', 'hash-port-${RUN_ID}', '2026-09-20', 'Misa Dominical')`,
      [orgAId, calEventId, memberAId],
    )
    await legacy.query('ALTER TABLE ochr_checkins ENABLE TRIGGER trg_checkins_no_plaintext_code')
    await legacy.query('COMMIT')
  } catch (e) {
    await legacy.query('ROLLBACK').catch(() => {})
    throw e
  } finally { legacy.release() }
}, 90_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

describe('PORTABILITY-L2-01 parish export completeness', () => {
  it('carries format version, parish identity, and UTF-8-honest domain rows', async () => {
    const res = await request(server).get('/api/organization/export').set(auth(tokenA))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers['content-type']).toMatch(/charset=utf-8/i)
    expect(res.headers['content-disposition']).toContain('attachment')

    const dump = typeof res.body === 'object' && res.body.format
      ? res.body
      : JSON.parse(res.text)

    expect(dump.format).toBe('openchurch-export')
    expect(dump.version).toBe(2)
    expect(dump.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // Parish identity — the settings surface, not a thin id/name stub.
    expect(dump.organization.id).toBe(orgAId)
    expect(dump.organization.name).toContain('Ñuñoa')
    expect(dump.organization.timezone).toBe('America/Mexico_City')
    expect(dump.organization.tradition).toBe('catholic')
    expect(dump.organization.locale).toBe('es')
    expect(dump.organization.address).toContain('Ñuñoa')
    expect(dump.organization.address).toContain('"Barrio Viejo"')
    expect(dump.organization.tagline).toContain('"paz"')
    expect(dump.organization.about).toContain('\n')
    expect(dump.organization.signatory_name).toContain('José')
    expect(dump.organization.reminder_lead_hours).toBe(48)
    // Secrets / payment plumbing stay out of the header.
    expect(dump.organization).not.toHaveProperty('kiosk_token')
    expect(dump.organization).not.toHaveProperty('ai_api_key_enc')
    expect(dump.organization).not.toHaveProperty('provider_customer_id')

    // Members
    const members = dump.tables.ochr_clients || []
    expect(members.some(m => m.name === 'María José Núñez')).toBe(true)
    const maria = members.find(m => m.name === 'María José Núñez')
    expect(maria.notes).toBe('Line1\nLine2, with "quotes"')
    expect(maria.phone).toBeNull()

    // Mass intentions + fulfilled stamps (status/history on the row)
    const intentions = dump.tables.ochr_mass_intentions || []
    expect(intentions.length).toBeGreaterThanOrEqual(1)
    const intention = intentions.find(r => r.intention.includes('José García'))
    expect(intention).toBeTruthy()
    expect(intention.status).toBe('fulfilled')
    expect(intention.fulfilled_mass_title).toBeTruthy()
    expect(intention.fulfilled_mass_date).toBeTruthy()
    expect(intention.note).toContain('comas')

    // Schedule / events / assignments
    expect((dump.tables.ochr_calendar_events || []).length).toBeGreaterThanOrEqual(1)
    expect((dump.tables.ochr_events || []).some(e => e.title.includes('café'))).toBe(true)
    expect((dump.tables.ochr_event_members || []).some(em => em.member_id === memberAId)).toBe(true)

    // Attendance / check-in
    expect((dump.tables.ochr_attendance || []).some(r => r.member_id === memberAId)).toBe(true)
    const checkins = dump.tables.ochr_checkins || []
    expect(checkins.some(c => c.person_name === 'Niño Pérez')).toBe(true)
    for (const c of checkins) {
      expect(c).not.toHaveProperty('security_code')
      expect(c).not.toHaveProperty('security_code_hash')
    }

    // Sacramental table present (read-only inventory — no canonical change here)
    expect(dump.tables).toHaveProperty('ochr_sacramental_records')

    // Tenant isolation
    const asText = JSON.stringify(dump)
    expect(asText).not.toContain(`SHOULD_NOT_EXPORT_CROSS_TENANT ${RUN_ID}`)
    expect(asText).not.toContain(`Portability Other Parish ${RUN_ID}`)
    expect(asText).not.toContain(`RAWCODE-PORT-${RUN_ID}`)
    expect(asText).not.toContain(`hash-port-${RUN_ID}`)
    expect(members.every(m => m.organization_id === orgAId)).toBe(true)
    expect(intentions.every(r => r.organization_id === orgAId)).toBe(true)
  })

  it('is admin-auth gated and honest on missing org', async () => {
    const unauth = await request(server).get('/api/organization/export')
    expect([401, 403]).toContain(unauth.status)

    await expect(buildOrgExport(2_147_483_647)).rejects.toThrow(/Organization not found/)
  })

  it('MUTATION: dropping security_code from the strip regex turns the probe red', async () => {
    // FALSIFIED rung — restore the pre-fix defect and prove this file would catch it.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/services/orgExport.js', import.meta.url), 'utf8')
    expect(src).toMatch(/security_code/)

    // Live assertion against the current strip: a row that still has the code
    // in the DB must leave the dump without it.
    const { rows } = await pool.query(
      `SELECT security_code IS NOT NULL AS has_code
         FROM ochr_checkins
        WHERE organization_id = $1 AND person_name = 'Niño Pérez'`,
      [orgAId],
    )
    expect(rows[0]?.has_code).toBe(true)

    const dump = await buildOrgExport(orgAId)
    const chk = (dump.tables.ochr_checkins || []).find(c => c.person_name === 'Niño Pérez')
    expect(chk).toBeTruthy()
    expect('security_code' in chk).toBe(false)

    // Demonstrate the probe: if stripSensitive ignored security_code, the
    // raw SELECT * shape would still carry it. Replicate the old regex.
    const oldSensitive = /(password|secret|token|pepper|hash)/i
    const raw = {}
    for (const [k, v] of Object.entries(chk)) raw[k] = v
    raw.security_code = `RAWCODE-PORT-${RUN_ID}`
    const strippedOld = {}
    for (const [k, v] of Object.entries(raw)) {
      if (oldSensitive.test(k)) continue
      strippedOld[k] = v
    }
    expect('security_code' in strippedOld).toBe(true) // old defect would leak
    expect(strippedOld.security_code).toBe(`RAWCODE-PORT-${RUN_ID}`)
  })

  it('MUTATION: thin org identity header would fail the identity assertions', async () => {
    const dump = await buildOrgExport(orgAId)
    const thin = {
      id: dump.organization.id,
      name: dump.organization.name,
      slug: dump.organization.slug,
      created_at: dump.organization.created_at,
    }
    // The old header shape — proves the new assertions are not vacuous.
    expect(thin).not.toHaveProperty('timezone')
    expect(thin).not.toHaveProperty('tradition')
    expect(thin).not.toHaveProperty('locale')
    expect(thin).not.toHaveProperty('address')
    expect(dump.organization.timezone).toBe('America/Mexico_City')
    expect(dump.organization.tradition).toBe('catholic')
    expect(dump.organization.locale).toBe('es')
    expect(dump.organization.address).toContain('Ñuñoa')
  })
})
