// OC-CYCLE-MAX-04 / TENANCY-L3-02 — cross-parish isolation falsification
// for Golden Journey 1–2 surfaces + parish export (PORTABILITY-L2-01).
//
// CLAIM: tenant boundaries on shipped endpoints used by GJ1 (intention book,
// sacristy weekly/nearest, calendar detail, packet), GJ2 (members, sacraments
// list/detail/correct/void, certificate path, member nested reads), and
// GET /api/organization/export refuse cross-parish access under:
//   direct ID substitution; list/detail mismatch; create/update/delete with
//   another church's IDs; nested/FK ownership mismatch; export filtering;
//   audit-log visibility; unauthenticated / wrong-role where supported.
//
// WHAT WOULD MAKE THESE FAIL
//   - Church B reading Church A's member / intention / sacrament / calendar
//     / packet / audit / export content
//   - Church B mutating Church A's rows (PATCH/DELETE/assign/void)
//   - Church A writing a FK that points at Church B's member or Mass
//   - Export dump carrying Church B markers or Church B organization_id rows
//   - Unauthenticated or viewer role reaching admin-only export / audit
//
// Evidence: LOCAL POSTGRES RUNTIME VERIFIED on disposable openchurch_local.
// Synthetic Church A / Church B only. No RLS / schema / auth redesign here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let tokenA, tokenB, tokenAViewer
let orgAId, orgBId
let memberAId, memberBId
let massAId, massBId
let intentionAId, intentionBId
let sacramentAId, sacramentBId
let feastAId
let draftAId

const MARKER_A = `TENANCY_L302_A_${RUN_ID}`
const MARKER_B = `TENANCY_L302_B_${RUN_ID}`
const MASS_DATE = '2031-06-15'
const PACKET_SUNDAY = '2031-06-15'

const auth = token => ({ Authorization: `Bearer ${token}` })

function refuseCrossTenant(res) {
  // Same answer for "not found" and "not yours" — never confirm existence
  // with 403 on these parish surfaces.
  expect([404, 400, 409]).toContain(res.status)
  if (res.status === 200 || res.status === 201) {
    throw new Error(`cross-tenant call unexpectedly succeeded: ${res.status} ${JSON.stringify(res.body)}`)
  }
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const a = await createOrg(server, {
    organizationName: `Tenancy L302 Church A ${RUN_ID}`,
    name: 'Ada Admin',
    email: `tenancy_l302_a_${RUN_ID}@example.com`,
    password: 'tenancy-l302-pw-a1',
  }, '10.252.2.1')
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgAId = a.body.user.organization.id

  const b = await createOrg(server, {
    organizationName: `Tenancy L302 Church B ${RUN_ID}`,
    name: 'Bea Admin',
    email: `tenancy_l302_b_${RUN_ID}@example.com`,
    password: 'tenancy-l302-pw-b1',
  }, '10.252.2.2')
  expect(b.status).toBe(201)
  tokenB = b.body.token
  orgBId = b.body.user.organization.id

  // Viewer on Church A — export and audit are admin-only.
  const viewer = await request(server).post('/api/users').set(auth(tokenA)).send({
    name: 'Vera Viewer',
    email: `tenancy_l302_av_${RUN_ID}@example.com`,
    password: 'tenancy-l302-pw-av',
    role: 'viewer',
  })
  expect(viewer.status).toBe(201)
  const loginViewer = await request(server).post('/api/auth/login')
    .set('X-Forwarded-For', '10.252.2.3')
    .send({ email: `tenancy_l302_av_${RUN_ID}@example.com`, password: 'tenancy-l302-pw-av' })
  expect(loginViewer.status).toBe(200)
  tokenAViewer = loginViewer.body.token

  const mA = await request(server).post('/api/clients').set(auth(tokenA)).send({
    name: `${MARKER_A} Member`,
    email: `member_a_${RUN_ID}@example.com`,
  })
  expect(mA.status).toBe(201)
  memberAId = mA.body.id

  const mB = await request(server).post('/api/clients').set(auth(tokenB)).send({
    name: `${MARKER_B} Member`,
    email: `member_b_${RUN_ID}@example.com`,
  })
  expect(mB.status).toBe(201)
  memberBId = mB.body.id

  const calA = await request(server).post('/api/calendar').set(auth(tokenA)).send({
    title: `${MARKER_A} Mass`,
    date: MASS_DATE,
    start_time: '10:00',
    end_time: '11:00',
    type: 'mass',
  })
  expect(calA.status).toBe(201)
  massAId = calA.body.id

  const calB = await request(server).post('/api/calendar').set(auth(tokenB)).send({
    title: `${MARKER_B} Mass`,
    date: MASS_DATE,
    start_time: '10:00',
    end_time: '11:00',
    type: 'mass',
  })
  expect(calB.status).toBe(201)
  massBId = calB.body.id

  const miA = await request(server).post('/api/mass-intentions').set(auth(tokenA)).send({
    intention: `† ${MARKER_A} Soul`,
    requested_by_client_id: memberAId,
    status: 'open',
  })
  expect(miA.status).toBe(201)
  const assignA = await request(server)
    .post(`/api/mass-intentions/${miA.body.id}/assign`)
    .set(auth(tokenA))
    .send({ calendar_event_id: massAId })
  expect(assignA.status).toBe(200)
  intentionAId = assignA.body.id

  const miB = await request(server).post('/api/mass-intentions').set(auth(tokenB)).send({
    intention: `† ${MARKER_B} Soul`,
    requested_by_client_id: memberBId,
    status: 'open',
  })
  expect(miB.status).toBe(201)
  const assignB = await request(server)
    .post(`/api/mass-intentions/${miB.body.id}/assign`)
    .set(auth(tokenB))
    .send({ calendar_event_id: massBId })
  expect(assignB.status).toBe(200)
  intentionBId = assignB.body.id

  const sacA = await request(server).post('/api/sacraments').set(auth(tokenA)).send({
    client_id: memberAId,
    type: 'baptism',
    date: '2010-04-11',
    minister: `${MARKER_A} Minister`,
    place: `${MARKER_A} Font`,
    certificate_no: `CERT-A-${RUN_ID}`,
  })
  expect(sacA.status).toBe(201)
  sacramentAId = sacA.body.id

  const sacB = await request(server).post('/api/sacraments').set(auth(tokenB)).send({
    client_id: memberBId,
    type: 'baptism',
    date: '2011-05-12',
    minister: `${MARKER_B} Minister`,
    place: `${MARKER_B} Font`,
    certificate_no: `CERT-B-${RUN_ID}`,
  })
  expect(sacB.status).toBe(201)
  sacramentBId = sacB.body.id

  const feast = await request(server).post('/api/parish-feasts').set(auth(tokenA)).send({
    date: MASS_DATE,
    feast_name: `${MARKER_A} Patronal`,
    liturgical_color: 'White',
  })
  expect(feast.status).toBe(201)
  feastAId = feast.body.id

  const draft = await request(server).post('/api/sacraments/drafts').set(auth(tokenA)).send({
    drafts: [{
      source: 'manual',
      draft: {
        member_name: `${MARKER_A} Draft Subject`,
        type: 'confirmation',
        date: '2015-06-01',
        minister: `${MARKER_A} Draft Minister`,
      },
    }],
  })
  expect(draft.status).toBe(201)
  draftAId = draft.body.drafts[0].id

  const donA = await request(server).post('/api/donations').set(auth(tokenA)).send({
    donor_name: `${MARKER_A} Member`,
    donor_email: `member_a_${RUN_ID}@example.com`,
    amount: 25,
    category: 'tithe',
    method: 'cash',
    date: '2031-06-01',
  })
  expect(donA.status).toBe(201)

  const blackout = await request(server).post('/api/availability').set(auth(tokenA)).send({
    client_id: memberAId,
    start_date: '2031-07-01',
    end_date: '2031-07-03',
    reason: `${MARKER_A} blackout`,
  })
  expect(blackout.status).toBe(201)
}, 120_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

describe('TENANCY-L3-02 same-tenant baseline (suite is not vacuous)', () => {
  it('Church A sees its own GJ markers on list surfaces', async () => {
    const clients = await request(server).get(`/api/clients?search=${MARKER_A}`).set(auth(tokenA))
    expect(clients.status).toBe(200)
    expect(JSON.stringify(clients.body)).toContain(MARKER_A)

    const intentions = await request(server).get(`/api/mass-intentions?q=${MARKER_A}`).set(auth(tokenA))
    expect(intentions.status).toBe(200)
    expect(JSON.stringify(intentions.body)).toContain(MARKER_A)

    const sacraments = await request(server).get(`/api/sacraments?q=${MARKER_A}`).set(auth(tokenA))
    expect(sacraments.status).toBe(200)
    expect(JSON.stringify(sacraments.body)).toContain(MARKER_A)

    const weekly = await request(server)
      .get(`/api/mass-intentions/weekly?start=${MASS_DATE}&end=${MASS_DATE}`)
      .set(auth(tokenA))
    expect(weekly.status).toBe(200)
    expect(JSON.stringify(weekly.body)).toContain(MARKER_A)
  })
})

describe('attack class: direct ID substitution (read)', () => {
  it('Church B cannot GET Church A member / intention / sacrament / calendar / feast', async () => {
    refuseCrossTenant(await request(server).get(`/api/clients/${memberAId}`).set(auth(tokenB)))
    refuseCrossTenant(await request(server).get(`/api/mass-intentions/${intentionAId}`).set(auth(tokenB)))
    refuseCrossTenant(await request(server).get(`/api/sacraments/${sacramentAId}`).set(auth(tokenB)))
    refuseCrossTenant(await request(server).get(`/api/calendar/${massAId}`).set(auth(tokenB)))

    const feastDel = await request(server).delete(`/api/parish-feasts/${feastAId}`).set(auth(tokenB))
    refuseCrossTenant(feastDel)
  })

  it('Church B list surfaces do not carry Church A markers', async () => {
    const surfaces = [
      `/api/clients?search=${MARKER_A}`,
      '/api/clients',
      `/api/mass-intentions?q=${MARKER_A}`,
      `/api/mass-intentions/weekly?start=${MASS_DATE}&end=${MASS_DATE}`,
      `/api/mass-intentions/nearest-outside?start=${MASS_DATE}&end=${MASS_DATE}`,
      `/api/mass-intentions/awaiting?date=${MASS_DATE}`,
      `/api/sacraments?q=${MARKER_A}`,
      `/api/sacraments?client_id=${memberAId}`,
      `/api/calendar?start=${MASS_DATE}&end=${MASS_DATE}`,
      `/api/packet?date=${PACKET_SUNDAY}`,
      '/api/parish-feasts',
      `/api/search?q=${MARKER_A}`,
      '/api/sacraments/drafts',
    ]
    for (const path of surfaces) {
      const res = await request(server).get(path).set(auth(tokenB))
      if (res.status === 200) {
        expect(JSON.stringify(res.body)).not.toContain(MARKER_A)
        expect(JSON.stringify(res.body)).not.toContain(`CERT-A-${RUN_ID}`)
      }
    }
  })
})

describe('attack class: list/detail mismatch', () => {
  it('Church B detail on A ids is 404 while A list still owns the row', async () => {
    const own = await request(server).get(`/api/clients/${memberAId}`).set(auth(tokenA))
    expect(own.status).toBe(200)
    expect(own.body.name).toContain(MARKER_A)

    const cross = await request(server).get(`/api/clients/${memberAId}`).set(auth(tokenB))
    expect(cross.status).toBe(404)

    const sacOwn = await request(server).get(`/api/sacraments/${sacramentAId}`).set(auth(tokenA))
    expect(sacOwn.status).toBe(200)
    const sacCross = await request(server).get(`/api/sacraments/${sacramentAId}`).set(auth(tokenB))
    expect(sacCross.status).toBe(404)

    // Filter by foreign client_id must not invent rows — empty list is fine;
    // a 200 that carries A's sacrament marker is a leak.
    const byClient = await request(server).get(`/api/sacraments?client_id=${memberAId}`).set(auth(tokenB))
    expect(byClient.status).toBe(200)
    expect(JSON.stringify(byClient.body)).not.toContain(MARKER_A)
    expect(byClient.body.records || []).toHaveLength(0)
  })
})

describe('attack class: create/update/delete with another church’s IDs', () => {
  it('Church B cannot PATCH / DELETE / assign / unassign / void Church A rows', async () => {
    refuseCrossTenant(
      await request(server).patch(`/api/clients/${memberAId}`).set(auth(tokenB)).send({ notes: 'hijack' }),
    )
    refuseCrossTenant(
      await request(server).delete(`/api/clients/${memberAId}`).set(auth(tokenB)),
    )
    refuseCrossTenant(
      await request(server).patch(`/api/mass-intentions/${intentionAId}`).set(auth(tokenB)).send({ note: 'hijack' }),
    )
    refuseCrossTenant(
      await request(server).post(`/api/mass-intentions/${intentionAId}/assign`).set(auth(tokenB))
        .send({ calendar_event_id: massBId }),
    )
    refuseCrossTenant(
      await request(server).post(`/api/mass-intentions/${intentionAId}/unassign`).set(auth(tokenB)).send({}),
    )
    refuseCrossTenant(
      await request(server).delete(`/api/mass-intentions/${intentionAId}`).set(auth(tokenB)),
    )
    refuseCrossTenant(
      await request(server).patch(`/api/sacraments/${sacramentAId}`).set(auth(tokenB))
        .send({ reason: 'cross-tenant rewrite attempt', place: 'Nowhere' }),
    )
    refuseCrossTenant(
      await request(server).post(`/api/sacraments/${sacramentAId}/void`).set(auth(tokenB))
        .send({ reason: 'cross-tenant void attempt' }),
    )
    refuseCrossTenant(
      await request(server).patch(`/api/sacraments/drafts/${draftAId}`).set(auth(tokenB))
        .send({ status: 'discarded' }),
    )
    refuseCrossTenant(
      await request(server).post(`/api/sacraments/drafts/${draftAId}/commit`).set(auth(tokenB)).send({}),
    )

    // Prove A rows survived.
    const still = await request(server).get(`/api/clients/${memberAId}`).set(auth(tokenA))
    expect(still.status).toBe(200)
    expect(still.body.notes).not.toBe('hijack')
    const mi = await request(server).get(`/api/mass-intentions/${intentionAId}`).set(auth(tokenA))
    expect(mi.status).toBe(200)
    expect(mi.body.note).not.toBe('hijack')
    const sac = await request(server).get(`/api/sacraments/${sacramentAId}`).set(auth(tokenA))
    expect(sac.status).toBe(200)
    expect(sac.body.voided_at == null).toBe(true)
  })
})

describe('attack class: nested / FK ownership mismatch', () => {
  it('Church A cannot create an intention linked to Church B member or Mass', async () => {
    const withMember = await request(server).post('/api/mass-intentions').set(auth(tokenA)).send({
      intention: `${MARKER_A} should refuse B member`,
      requested_by_client_id: memberBId,
    })
    refuseCrossTenant(withMember)

    const withMass = await request(server).post('/api/mass-intentions').set(auth(tokenA)).send({
      intention: `${MARKER_A} should refuse B mass`,
      calendar_event_id: massBId,
    })
    refuseCrossTenant(withMass)

    const assignCross = await request(server)
      .post(`/api/mass-intentions/${intentionAId}/assign`)
      .set(auth(tokenA))
      .send({ calendar_event_id: massBId })
    refuseCrossTenant(assignCross)
  })

  it('Church A cannot create / correct a sacrament linked to Church B member', async () => {
    const create = await request(server).post('/api/sacraments').set(auth(tokenA)).send({
      client_id: memberBId,
      type: 'baptism',
      date: '2012-01-01',
      minister: 'Fr. Cross',
      member_name: 'Should Not Link',
    })
    refuseCrossTenant(create)

    const correct = await request(server).patch(`/api/sacraments/${sacramentAId}`).set(auth(tokenA)).send({
      reason: 'attempt cross-tenant relink',
      client_id: memberBId,
    })
    refuseCrossTenant(correct)

    const draftCommit = await request(server).post('/api/sacraments/drafts').set(auth(tokenA)).send({
      drafts: [{
        source: 'manual',
        draft: {
          client_id: memberBId,
          member_name: 'Draft Cross',
          type: 'baptism',
          date: '2013-01-01',
        },
      }],
    })
    expect(draftCommit.status).toBe(201)
    const stagedId = draftCommit.body.drafts[0].id
    const commit = await request(server)
      .post(`/api/sacraments/drafts/${stagedId}/commit`)
      .set(auth(tokenA))
      .send({})
    expect([400, 404]).toContain(commit.status)
  })

  it('Church A cannot open a blackout on Church B member', async () => {
    const res = await request(server).post('/api/availability').set(auth(tokenA)).send({
      client_id: memberBId,
      start_date: '2031-08-01',
      end_date: '2031-08-02',
      reason: 'cross blackout',
    })
    refuseCrossTenant(res)
  })

  it('Church A packet does not resolve Church B member names from assigned_to ids', async () => {
    // Calendar stores assigned_to as jsonb without a composite FK. If the
    // packet JOIN ever dropped the org predicate, B's name would appear on
    // A's Sunday packet — that is the leak this probe watches for.
    const stamped = await pool.query(
      `UPDATE ochr_calendar_events
          SET assigned_to = $1::jsonb
        WHERE id = $2 AND organization_id = $3
        RETURNING id`,
      [JSON.stringify([memberBId]), massAId, orgAId],
    )
    expect(stamped.rowCount).toBe(1)

    const packet = await request(server).get(`/api/packet?date=${PACKET_SUNDAY}`).set(auth(tokenA))
    expect(packet.status).toBe(200)
    expect(JSON.stringify(packet.body)).not.toContain(MARKER_B)
    expect(JSON.stringify(packet.body)).not.toContain(`member_b_${RUN_ID}`)

    // Restore clean assignment for later export checks.
    await pool.query(
      `UPDATE ochr_calendar_events SET assigned_to = '[]'::jsonb WHERE id = $1 AND organization_id = $2`,
      [massAId, orgAId],
    )
  })
})

describe('attack class: export filtering (PORTABILITY-L2-01)', () => {
  it('Church A export carries only Church A rows and markers', async () => {
    const res = await request(server).get('/api/organization/export').set(auth(tokenA))
    expect(res.status).toBe(200)
    const dump = typeof res.body === 'object' && res.body.format
      ? res.body
      : JSON.parse(res.text)

    expect(Number(dump.organization.id)).toBe(Number(orgAId))
    const asText = JSON.stringify(dump)
    expect(asText).toContain(MARKER_A)
    expect(asText).not.toContain(MARKER_B)
    expect(asText).not.toContain(`Tenancy L302 Church B ${RUN_ID}`)
    expect(asText).not.toContain(`CERT-B-${RUN_ID}`)

    for (const [table, rows] of Object.entries(dump.tables || {})) {
      for (const row of rows) {
        if (row && Object.prototype.hasOwnProperty.call(row, 'organization_id')) {
          // pg may serialize bigint org ids as strings in JSON attachments.
          expect(Number(row.organization_id), table).toBe(Number(orgAId))
        }
      }
    }
  })

  it('Church B export does not carry Church A markers', async () => {
    const res = await request(server).get('/api/organization/export').set(auth(tokenB))
    expect(res.status).toBe(200)
    const dump = typeof res.body === 'object' && res.body.format
      ? res.body
      : JSON.parse(res.text)
    const asText = JSON.stringify(dump)
    expect(asText).toContain(MARKER_B)
    expect(asText).not.toContain(MARKER_A)
    expect(Number(dump.organization.id)).toBe(Number(orgBId))
  })
})

describe('attack class: audit-log visibility', () => {
  it('Church B cannot see Church A audit rows by marker or entity_id', async () => {
    const listB = await request(server).get('/api/audit-log?limit=100').set(auth(tokenB))
    expect(listB.status).toBe(200)
    expect(JSON.stringify(listB.body)).not.toContain(MARKER_A)
    expect(JSON.stringify(listB.body)).not.toContain(`member_a_${RUN_ID}`)

    const byEntity = await request(server)
      .get(`/api/audit-log?entity_type=client&entity_id=${memberAId}`)
      .set(auth(tokenB))
    expect(byEntity.status).toBe(200)
    expect(JSON.stringify(byEntity.body)).not.toContain(MARKER_A)
    expect((byEntity.body.rows || []).every(r => String(r.entity_id) !== String(memberAId)
      || !JSON.stringify(r).includes(MARKER_A))).toBe(true)
    // Foreign entity_id filter must not surface A's create row.
    expect((byEntity.body.rows || []).filter(r => String(r.entity_id) === String(memberAId))).toHaveLength(0)

    const csv = await request(server).get('/api/audit-log/export.csv').set(auth(tokenB))
    expect(csv.status).toBe(200)
    expect(csv.text).not.toContain(MARKER_A)

    const listA = await request(server).get('/api/audit-log?limit=100').set(auth(tokenA))
    expect(listA.status).toBe(200)
    expect(JSON.stringify(listA.body)).toContain(MARKER_A)
  })
})

describe('attack class: unauthenticated / wrong-role', () => {
  it('unauthenticated callers are refused on GJ + export + audit mounts', async () => {
    const paths = [
      `/api/clients/${memberAId}`,
      `/api/mass-intentions/${intentionAId}`,
      `/api/mass-intentions/weekly?start=${MASS_DATE}&end=${MASS_DATE}`,
      `/api/sacraments/${sacramentAId}`,
      `/api/calendar/${massAId}`,
      `/api/packet?date=${PACKET_SUNDAY}`,
      '/api/organization/export',
      '/api/audit-log',
    ]
    for (const path of paths) {
      const res = await request(server).get(path)
      expect([401, 403]).toContain(res.status)
    }
  })

  it('viewer on Church A cannot pull export or audit log', async () => {
    const exp = await request(server).get('/api/organization/export').set(auth(tokenAViewer))
    expect(exp.status).toBe(403)
    const audit = await request(server).get('/api/audit-log').set(auth(tokenAViewer))
    expect(audit.status).toBe(403)
  })

  it('Church B admin cannot read Church A nested member donations / checkins', async () => {
    refuseCrossTenant(
      await request(server).get(`/api/clients/${memberAId}/donations`).set(auth(tokenB)),
    )
    refuseCrossTenant(
      await request(server).get(`/api/clients/${memberAId}/checkins`).set(auth(tokenB)),
    )
  })
})

describe('MUTATION probes — boundary removal turns red', () => {
  it('clients detail SQL still scopes by organization_id', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/clients.js', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(
      /SELECT \$\{CLIENT_PUBLIC_COLUMNS\} FROM ochr_clients WHERE id = \$1 AND organization_id = \$2/,
    )
  })

  it('mass-intention detail and assign still scope by organization_id', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/massIntentions.js', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(/WHERE s\.id = \$1 AND s\.organization_id = \$2/)
    expect(src).toMatch(/WHERE id = \$1 AND organization_id = \$2\s+FOR UPDATE/)
    expect(src).toMatch(/FROM ochr_calendar_events WHERE id = \$1 AND organization_id = \$2/)
  })

  it('sacrament detail / clientInOrg still scope by organization_id', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/sacraments.js', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(/WHERE s\.id = \$1 AND s\.organization_id = \$2/)
    expect(src).toMatch(
      /SELECT 1 FROM ochr_clients WHERE id = \$1 AND organization_id = \$2/,
    )
  })

  it('org export SELECT still filters WHERE organization_id = $1', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/services/orgExport.js', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(/SELECT \* FROM \$\{table\} WHERE organization_id = \$1 ORDER BY 1/)
  })

  it('audit list keeps organization_id literal in the query text', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/auditLog.js', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(/FROM ochr_audit_log\s+WHERE organization_id = \$1\$\{extraSql\}/)
  })

  it('packet serving join keeps organization_id on the member lookup', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/packet.js', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(/cl\.organization_id = ce\.organization_id/)
    expect(src).toMatch(/WHERE ce\.organization_id = \$1 AND ce\.date = \$2::date/)
  })

  it('live DB probe: stripping org predicate from a clients SELECT would return the foreign row', async () => {
    // Demonstrates the FALSIFIED rung: the defect the route guards against
    // is real — without organization_id, Church A's id is readable as a
    // bare primary key. The HTTP tests above prove the route keeps the guard.
    const unscoped = await pool.query(
      `SELECT name FROM ochr_clients WHERE id = $1`,
      [memberAId],
    )
    expect(unscoped.rows[0]?.name).toContain(MARKER_A)

    const scoped = await pool.query(
      `SELECT name FROM ochr_clients WHERE id = $1 AND organization_id = $2`,
      [memberAId, orgBId],
    )
    expect(scoped.rows).toHaveLength(0)
  })
})
