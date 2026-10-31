// OC-CAT-1 — parish hall holds, expected deposit schedules, hall agreements.
// Real Postgres, synthetic parishes. Payments are on hold: this file
// fails if a catering call creates a deposit fact, a ledger row, or a charge.
//
// Red on main: these routes are not registered there, so the same file
// answers 404 / fails to import. Green here.
//
// A guard that stays green when broken is not a guard. Two probes are
// named so a reviewer can break them:
//   - drop organization_id from GET /bookings/:id and the cross-tenant
//     case goes red
//   - drop ochr_cat_bookings_no_overlap and the direct INSERT overlap goes red
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { buildMilestoneScheduleAndContract, lockGuaranteedHeadcount, parseAmountCents } from '../src/lib/catering/contract.js'
import { judgeCalendarRow } from '../src/lib/catering/conflicts.js'

// Counsel's wording is stood in with synthetic text so the send and sign
// paths can run. The real terms are still null; hallCounselGate.test.js
// proves that, with them, the link is not issued and cannot be signed.
vi.mock('../src/lib/catering/counselTerms.js', async (importOriginal) => {
  const real = await importOriginal()
  const words = (lang) => Object.fromEntries(
    ['cancellation', 'refund', 'liability', 'insurance', 'effect'].map(k => [k, `Synthetic counsel wording (${lang}): ${k}.`]))
  const supplied = { en: words('en'), es: words('es') }
  return { ...real, COUNSEL_TERMS: supplied, counselText: (l, t, terms = supplied) => real.counselText(l, t, terms) }
})

const PW = 'cat133-test-pw'
let server, A, B, staff, viewer
let ipSeq = 1
const nextIp = () => `10.133.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })

async function signup(tag) {
  const email = `cat133_${tag}_${RUN_ID}@example.com`
  const r = await createOrg(server, {
    organizationName: `CAT133 ${tag} ${RUN_ID}`, name: `Admin ${tag}`, email, password: PW,
  }, nextIp())
  expect(r.status).toBe(201)
  return { id: r.body.user.organization.id, token: r.body.token, name: `Admin ${tag}` }
}
async function addUser(org, role, tag) {
  const email = `cat133_${tag}_${RUN_ID}@example.com`
  const c = await request(server).post('/api/users').set(auth(org.token)).set('X-Forwarded-For', nextIp())
    .send({ name: tag, email, password: PW, role })
  expect(c.status).toBe(201)
  const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PW })
  expect(l.status).toBe(200)
  return { token: l.body.token, id: l.body.user.id }
}

async function space(org, name, space_kind) {
  const r = await request(server).post('/api/catering/spaces').set(auth(org.token)).send({ name, space_kind })
  expect(r.status).toBe(201)
  expect(r.body.payments).toBe('on_hold')
  return r.body.space
}
function book(org, body) {
  return request(server).post('/api/catering/bookings').set(auth(org.token)).send(body)
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  A = await signup('a')
  B = await signup('b')
  staff = await addUser(A, 'staff', 'staff')
  viewer = await addUser(A, 'viewer', 'viewer')
  await pool.query(`UPDATE ochr_organizations SET timezone = 'UTC' WHERE id = ANY($1)`, [[A.id, B.id]])
  await pool.query(
    `INSERT INTO ochr_schedule
       (organization_id, title, service_type, day_of_week, start_time, end_time, recurrence, location)
     VALUES ($1, 'Sunday Mass', 'mass', 'Sunday', '10:00', '11:00', 'Weekly', 'Sanctuary'),
            ($1, 'Wednesday Mass', 'mass', 'Wednesday', '18:00', '19:00', 'Weekly', NULL)`,
    [A.id])
  await pool.query(
    `INSERT INTO ochr_calendar_events
       (organization_id, title, date, start_time, end_time, type)
     VALUES ($1, 'Parish picnic', '2026-10-31', '14:00', '16:00', 'event')`,
    [A.id])
  await pool.query(
    `INSERT INTO ochr_liturgical_calendar (date, season, feast_name, liturgical_color)
     VALUES ('2026-11-01', 'Ordinary Time', 'All Saints', 'white')
     ON CONFLICT (date) DO NOTHING`, [])
}, 120_000)

afterAll(async () => {
  for (const id of [A?.id, B?.id]) if (id) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('133 migration', () => {
  it('follows 132, re-runs, and excludes overlapping holds', async () => {
    const { MIGRATION_NAMES, EXPECTED_MIGRATION } = await import('../src/migrations/names.js')
    expect(EXPECTED_MIGRATION).toBe('144-online-giving-clearing')
    const i = MIGRATION_NAMES.indexOf('133-parish-catering')
    expect(MIGRATION_NAMES[i - 1]).toBe('132-effective-dated-mappings')
    const { up } = await import('../src/migrations/133-parish-catering.js')
    await up(); await up()
    const ex = await pool.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ochr_cat_bookings_no_overlap'`)
    expect(ex.rows[0].def).toMatch(/during/)
    expect(ex.rows[0].def).toMatch(/held/)
    const rls = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'ochr_cat_bookings'`)
    expect(rls.rows[0].relrowsecurity).toBe(true)
  })
})

describe('schedule records are not charges', () => {
  it('refuses a blank amount and does not invent a fee', () => {
    expect(parseAmountCents('')).toBeNull()
    expect(parseAmountCents(false)).toBeNull()
    expect(parseAmountCents('10.10')).toBe(1010)
    const built = buildMilestoneScheduleAndContract({
      eventKind: 'wedding', hostName: 'Ada and Ben', spaceName: 'Sanctuary',
      startsAt: '2026-11-07T15:00:00.000Z', endsAt: '2026-11-07T16:00:00.000Z',
      milestones: [{ kind: 'date_hold', amount: '10.10', due_on: '2026-10-01' }],
    })
    expect(built.ok).toBe(true)
    expect(built.schedule[0].amount_cents).toBe(1010)
    expect(built.payments).toBe('on_hold')
    expect(JSON.stringify(built)).not.toMatch(/stripe|checkout|client_secret|payment_intent/i)
    expect(lockGuaranteedHeadcount({ lockedAt: 't', currentCount: 40, nextCount: 41 }).ok).toBe(false)
    expect(lockGuaranteedHeadcount({ lockedAt: 't', currentCount: 40, nextCount: 40 }).unchanged).toBe(true)
  })

  it('does not treat an unplaced calendar row as a sanctuary conflict', () => {
    const judged = judgeCalendarRow({
      space: { name: 'Sanctuary', space_kind: 'sanctuary' },
      bookingStart: new Date('2026-10-31T14:00:00.000Z'),
      bookingEnd: new Date('2026-10-31T16:00:00.000Z'),
      timeZone: 'UTC',
      row: { title: 'Parish picnic', date: '2026-10-31', start_time: '14:00:00', end_time: '16:00:00', type: 'event' },
    })
    expect(judged.conflict).toBeUndefined()
    expect(judged.unplaced.room).toBe('unknown')
  })
})

describe('hall holds', () => {
  it('refuses a viewer, an anonymous caller, and another parish', async () => {
    const anon = await request(server).get('/api/catering/spaces')
    expect(anon.status).toBe(401)
    const v = await request(server).get('/api/catering/spaces').set(auth(viewer.token))
    expect(v.status).toBe(403)
    const sanctuary = await space(A, 'Sanctuary', 'sanctuary')
    const hall = await space(A, 'Fellowship Hall', 'fellowship_hall')
    const kitchen = await space(A, 'Kitchen', 'kitchen')
    const sunday = await book(A, {
      space_id: sanctuary.id, event_kind: 'wedding', host_name: 'Sample Couple',
      starts_at: '2026-11-01T10:30:00.000Z', ends_at: '2026-11-01T12:00:00.000Z',
    })
    expect(sunday.status).toBe(409)
    expect(sunday.body.conflicts.some(c => c.source === 'schedule' && c.title === 'Sunday Mass')).toBe(true)
    expect(sunday.body.payments).toBe('on_hold')

    const saturday = await book(A, {
      space_id: sanctuary.id, event_kind: 'wedding', host_name: 'Sample Couple',
      occasion: 'Nuptial Mass',
      starts_at: '2026-10-31T14:00:00.000Z', ends_at: '2026-10-31T16:00:00.000Z',
    })
    expect(saturday.status).toBe(201)
    expect(saturday.body.payments).toBe('on_hold')
    expect(saturday.body.unplaced.some(u => u.title === 'Parish picnic')).toBe(true)
    expect(saturday.body.liturgical_status).toBe('known')

    const reception = await book(A, {
      space_id: hall.id, event_kind: 'wedding', host_name: 'Sample Couple',
      starts_at: '2026-10-31T16:00:00.000Z', ends_at: '2026-10-31T19:00:00.000Z',
    })
    expect(reception.status).toBe(201)
    const supper = await book(A, {
      space_id: kitchen.id, event_kind: 'fellowship_dinner', host_name: 'Sample Couple',
      starts_at: '2026-10-31T16:00:00.000Z', ends_at: '2026-10-31T19:00:00.000Z',
    })
    expect(supper.status).toBe(201)

    const again = await book(A, {
      space_id: sanctuary.id, event_kind: 'rehearsal', host_name: 'Someone else',
      starts_at: '2026-10-31T15:00:00.000Z', ends_at: '2026-10-31T16:30:00.000Z',
    })
    expect(again.status).toBe(409)

    const otherSpace = await request(server).post('/api/catering/bookings').set(auth(B.token)).send({
      space_id: sanctuary.id, event_kind: 'hall_rental', host_name: 'Other parish',
      starts_at: '2026-12-01T15:00:00.000Z', ends_at: '2026-12-01T16:00:00.000Z',
    })
    expect(otherSpace.status).toBe(404)
    const peek = await request(server).get(`/api/catering/bookings/${saturday.body.id}`).set(auth(B.token))
    expect(peek.status).toBe(404)

    const wednesdayHall = await book(A, {
      space_id: hall.id, event_kind: 'fellowship_dinner', host_name: 'Knights supper',
      starts_at: '2026-10-28T18:00:00.000Z', ends_at: '2026-10-28T20:00:00.000Z',
    })
    expect(wednesdayHall.status).toBe(201)
    expect(wednesdayHall.body.unplaced.some(u => u.title === 'Wednesday Mass')).toBe(true)
    const wednesdaySanctuary = await book(A, {
      space_id: sanctuary.id, event_kind: 'rehearsal', host_name: 'Choir',
      starts_at: '2026-10-28T18:00:00.000Z', ends_at: '2026-10-28T19:00:00.000Z',
    })
    expect(wednesdaySanctuary.status).toBe(409)

    const mod = await request(server).get('/api/catering/modules').set(auth(A.token))
    expect(mod.body.catering.commit).toBe('6e57328b42da546589916cb0e1555157de5adc97')
    expect(mod.body.esign.commit).toBe('ea02cb3')
    expect(mod.body.payments).toBe('on_hold')
    expect(mod.body.catering.readable).toBe(false)
  })

  it('keeps the register unchanged and does not write deposit facts', async () => {
    const { rows: [marriage] } = await pool.query(
      `INSERT INTO ochr_sacramental_records (organization_id, type, date, place, member_name)
       VALUES ($1, 'marriage', '2026-10-31', 'Sanctuary', 'Sample Couple')
       RETURNING id, type, date::text, place, member_name, notes, updated_at`, [A.id])
    const { rows: [baptism] } = await pool.query(
      `INSERT INTO ochr_sacramental_records (organization_id, type, date, place, member_name)
       VALUES ($1, 'baptism', '2026-10-31', 'Sanctuary', 'Sample Child') RETURNING id`, [A.id])
    const { rows: [booking] } = await pool.query(
      `SELECT id FROM ochr_cat_bookings WHERE organization_id = $1 AND host_name = 'Sample Couple' AND event_kind = 'wedding' ORDER BY id LIMIT 1`,
      [A.id])
    const wholeDay = await book(A, {
      space_id: (await pool.query(`SELECT id FROM ochr_cat_spaces WHERE organization_id = $1 AND name = 'Sanctuary'`, [A.id])).rows[0].id,
      event_kind: 'rehearsal', host_name: 'Another couple',
      starts_at: '2026-10-31T20:00:00.000Z', ends_at: '2026-10-31T21:00:00.000Z',
    })
    expect(wholeDay.status).toBe(409)
    expect(wholeDay.body.conflicts.some(c => c.source === 'sacrament')).toBe(true)

    const linked = await request(server).post(`/api/catering/bookings/${booking.id}/marriage`).set(auth(A.token))
      .send({ record_id: marriage.id })
    expect(linked.status).toBe(200)
    expect(linked.body.register_unchanged).toBe(true)
    const after = await pool.query(
      `SELECT type, date::text, place, member_name, notes FROM ochr_sacramental_records WHERE id = $1 AND organization_id = $2`,
      [marriage.id, A.id])
    expect(after.rows[0]).toMatchObject({ type: 'marriage', place: 'Sanctuary', member_name: 'Sample Couple' })
    const notMarriage = await request(server).post(`/api/catering/bookings/${booking.id}/marriage`).set(auth(A.token))
      .send({ record_id: baptism.id })
    expect(notMarriage.status).toBe(409)
    const cross = await request(server).post(`/api/catering/bookings/${booking.id}/marriage`).set(auth(B.token))
      .send({ record_id: marriage.id })
    expect(cross.status).toBe(404)

    const { rows: [inv] } = await pool.query(
      `INSERT INTO ochr_invoices (organization_id, title, category, payer_name, status, subtotal, total, issued_at)
       VALUES ($1, 'Hall', 'wedding', 'Synthetic Payer', 'issued', 25, 25, NOW()) RETURNING id`, [A.id])
    await pool.query(
      `INSERT INTO ochr_invoice_lines (organization_id, invoice_id, description, qty, unit_amount, amount, account_code, sort_order)
       VALUES ($1, $2, 'Hall', 1, 25, 25, '4710', 0)`, [A.id, inv.id])
    const pay = await request(server).post(`/api/invoices/${inv.id}/payments`).set(auth(A.token))
      .send({ amount: 25, method: 'check', is_deposit: true })
    expect(pay.status).toBe(201)
    const factsBefore = (await pool.query(`SELECT COUNT(*)::int AS n FROM ochr_deposit_facts WHERE organization_id = $1`, [A.id])).rows[0].n
    const ledgerBefore = (await pool.query(`SELECT COALESCE(SUM(amount),0)::text AS n FROM ochr_parish_ledger WHERE organization_id = $1 AND account_code = '2300'`, [A.id])).rows[0].n
    const amounts = await request(server).put(`/api/catering/bookings/${booking.id}/milestones`).set(auth(staff.token)).send({
      milestones: [
        { kind: 'date_hold', amount: '10.10', due_on: '2026-10-01' },
        { kind: 'hall_rental', amount: '14.90', due_on: '2026-10-15' },
      ],
    })
    expect(amounts.status).toBe(200)
    expect(amounts.body.milestones[0].amount_cents).toBe(1010)
    const milestoneId = (await pool.query(
      `SELECT id FROM ochr_cat_milestones WHERE organization_id = $1 AND booking_id = $2 AND kind = 'date_hold'`,
      [A.id, booking.id])).rows[0].id
    const link = await request(server).post(`/api/catering/bookings/${booking.id}/milestones/${milestoneId}/deposit`)
      .set(auth(staff.token)).send({ payment_id: pay.body.id })
    expect(link.status).toBe(200)
    expect(link.body.deposit_facts_unchanged).toBe(true)
    expect(link.body.payments).toBe('on_hold')
    const factsAfter = (await pool.query(`SELECT COUNT(*)::int AS n FROM ochr_deposit_facts WHERE organization_id = $1`, [A.id])).rows[0].n
    const ledgerAfter = (await pool.query(`SELECT COALESCE(SUM(amount),0)::text AS n FROM ochr_parish_ledger WHERE organization_id = $1 AND account_code = '2300'`, [A.id])).rows[0].n
    expect(factsAfter).toBe(factsBefore)
    expect(ledgerAfter).toBe(ledgerBefore)
    const otherPay = await request(server).post(`/api/catering/bookings/${booking.id}/milestones/${milestoneId}/deposit`)
      .set(auth(B.token)).send({ payment_id: pay.body.id })
    expect(otherPay.status).toBe(404)
  })

  it('locks a guaranteed number and signs a hall agreement without email or a charge', async () => {
    const { rows: [booking] } = await pool.query(
      `SELECT id FROM ochr_cat_bookings WHERE organization_id = $1 AND host_name = 'Knights supper'`, [A.id])
    const beo = await request(server).put(`/api/catering/bookings/${booking.id}/beo`).set(auth(staff.token)).send({
      table_count: 8, chair_count: 64, layout: 'Round tables', kitchen_notes: 'Parish kitchen',
      allergen_notes: 'Two gluten-free', outside_caterer: '', guaranteed_count: 60,
    })
    expect(beo.status).toBe(200)
    expect(beo.body.beo.table_count).toBe(8)
    expect(beo.body.payments).toBe('on_hold')
    const lock = await request(server).post(`/api/catering/bookings/${booking.id}/beo/lock`).set(auth(staff.token))
      .send({ guaranteed_count: 60 })
    expect(lock.status).toBe(200)
    expect(lock.body.locked_at).toBeTruthy()
    const relock = await request(server).post(`/api/catering/bookings/${booking.id}/beo/lock`).set(auth(staff.token))
      .send({ guaranteed_count: 70 })
    expect(relock.status).toBe(409)
    const still = await pool.query(`SELECT guaranteed_count FROM ochr_cat_beos WHERE organization_id = $1 AND booking_id = $2`, [A.id, booking.id])
    expect(still.rows[0].guaranteed_count).toBe(60)

    const amounts = await request(server).put(`/api/catering/bookings/${booking.id}/milestones`).set(auth(staff.token)).send({
      milestones: [{ kind: 'hall_rental', amount: '0.00', due_on: '2026-10-20' }],
    })
    expect(amounts.status).toBe(200)
    const draft = await request(server).post(`/api/catering/bookings/${booking.id}/agreement`).set(auth(staff.token))
    expect(draft.status).toBe(201)
    expect(draft.body.contract_en).toMatch(/Nothing is charged/)
    expect(draft.body.contract_es).toMatch(/no cobra nada/)
    const staffSend = await request(server).post(`/api/catering/bookings/${booking.id}/agreement/send`).set(auth(staff.token))
      .send({ contract_sha256: draft.body.contract_sha256 })
    expect(staffSend.status).toBe(403)
    const sent = await request(server).post(`/api/catering/bookings/${booking.id}/agreement/send`).set(auth(A.token))
      .send({ contract_sha256: draft.body.contract_sha256 })
    expect(sent.status).toBe(200)
    expect(sent.body.email_verified).toBe(false)
    expect(sent.body.deposit_link).toBeNull()
    expect(sent.body.payments).toBe('on_hold')
    expect(JSON.stringify(sent.body)).not.toMatch(/stripe|checkout|client_secret/i)
    const frozen = await request(server).put(`/api/catering/bookings/${booking.id}/milestones`).set(auth(A.token)).send({
      milestones: [{ kind: 'hall_rental', amount: '9.00', due_on: '2026-10-20' }],
    })
    expect(frozen.status).toBe(409)
    const cents = await pool.query(
      `SELECT amount_cents FROM ochr_cat_milestones WHERE organization_id = $1 AND booking_id = $2`, [A.id, booking.id])
    expect(Number(cents.rows[0].amount_cents)).toBe(0)

    const token = decodeURIComponent(sent.body.copy_path.replace('/sign/hall/', ''))
    const opened = await request(server).get(`/api/hall-sign/${encodeURIComponent(token)}?locale=es`)
    expect(opened.status).toBe(200)
    expect(opened.body.contract).toMatch(/no cobra nada/)
    expect(opened.body.email_verified).toBe(false)
    const missing = await request(server).post(`/api/hall-sign/${encodeURIComponent(token)}/sign`).send({
      signer_name: 'Ada Sample', accepted: ['effect'], locale: 'en',
    })
    expect(missing.status).toBe(400)
    const signed = await request(server).post(`/api/hall-sign/${encodeURIComponent(token)}/sign`).send({
      signer_name: 'Ada Sample',
      accepted: opened.body.consent.map(p => p.id),
      locale: 'es',
    })
    expect(signed.status).toBe(200)
    expect(signed.body.status).toBe('signed')
    expect(signed.body.email_verified).toBe(false)
    const events = await pool.query(
      `SELECT kind FROM ochr_cat_agreement_events WHERE organization_id = $1 ORDER BY id`, [A.id])
    const kinds = events.rows.map(r => r.kind)
    expect(kinds).toEqual(expect.arrayContaining(['approval.recorded', 'email.not_sent', 'signer.consented', 'signer.signed', 'request.sealed']))
    expect(kinds).not.toContain('email.sent')
    const approval = await pool.query(
      `SELECT payload FROM ochr_cat_agreement_events WHERE organization_id = $1 AND kind = 'approval.recorded'`, [A.id])
    expect(approval.rows[0].payload.action).toBe('catering.send_event_contract_and_deposit_link')
    expect(approval.rows[0].payload.deposit_link).toBeNull()
    expect(JSON.stringify(approval.rows[0].payload)).not.toMatch(token)
    await expect(pool.query(
      `UPDATE ochr_cat_agreement_events SET kind = 'tampered' WHERE organization_id = $1 AND kind = 'email.not_sent'`,
      [A.id])).rejects.toThrow(/append-only/)
    await expect(pool.query(
      `DELETE FROM ochr_cat_agreements WHERE organization_id = $1 AND status = 'signed'`,
      [A.id])).rejects.toThrow(/not deleted/)

    const routeSrc = readFileSync(new URL('../src/routes/catering.js', import.meta.url), 'utf8')
    const signSrc = readFileSync(new URL('../src/routes/hallSign.js', import.meta.url), 'utf8')
    expect(routeSrc + signSrc).not.toMatch(/stripe|checkout\.session|paymentIntents|sk_live/i)
  })

  it('the database rejects a second held overlap even if the route is bypassed', async () => {
    const spaceId = (await pool.query(`SELECT id FROM ochr_cat_spaces WHERE organization_id = $1 AND name = 'Kitchen'`, [A.id])).rows[0].id
    await pool.query(
      `INSERT INTO ochr_cat_bookings
         (organization_id, space_id, event_kind, host_name, starts_at, ends_at, vertical_key)
       VALUES ($1, $2, 'hall_rental', 'Direct one', '2026-12-05T15:00:00Z', '2026-12-05T17:00:00Z', 'open-church')`,
      [A.id, spaceId])
    await expect(pool.query(
      `INSERT INTO ochr_cat_bookings
         (organization_id, space_id, event_kind, host_name, starts_at, ends_at, vertical_key)
       VALUES ($1, $2, 'hall_rental', 'Direct two', '2026-12-05T16:00:00Z', '2026-12-05T18:00:00Z', 'open-church')`,
      [A.id, spaceId])).rejects.toThrow(/ochr_cat_bookings_no_overlap|conflicting key/i)
  })
})

describe('Argus, Vesper, and Saint revisions', () => {
  it('keeps the signing link to admins, hashes the visitor, and does not reuse a token', async () => {
    const { rows: [booking] } = await pool.query(
      `SELECT id FROM ochr_cat_bookings WHERE organization_id = $1 AND host_name = 'Knights supper'`, [A.id])
    const staffView = await request(server).get(`/api/catering/bookings/${booking.id}`).set(auth(staff.token))
    expect(staffView.status).toBe(200)
    expect(JSON.stringify(staffView.body)).not.toMatch(/\/sign\/hall\//)
    const adminView = await request(server).get(`/api/catering/bookings/${booking.id}`).set(auth(A.token))
    expect(adminView.body.agreements.some(a => typeof a.copy_path === 'string' && a.copy_path.startsWith('/sign/hall/'))).toBe(true)

    const events = await pool.query(
      `SELECT kind, payload FROM ochr_cat_agreement_events WHERE organization_id = $1 AND kind IN ('link.opened', 'signer.signed', 'signer.declined')`,
      [A.id])
    const signed = events.rows.find(r => r.kind === 'signer.signed')
    expect(signed.payload.ip_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(signed.payload.user_agent).toBeTruthy()
    expect(JSON.stringify(signed.payload)).not.toMatch(/127\.0\.0\.1/)
    expect(events.rows.map(r => r.kind)).not.toContain('email.link_opened')

    const token = decodeURIComponent(adminView.body.agreements.find(a => a.copy_path).copy_path.replace('/sign/hall/', ''))
    const again = await request(server).get(`/api/hall-sign/${encodeURIComponent(token)}`)
    expect(again.status).toBe(200)
    const opens = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_cat_agreement_events WHERE organization_id = $1 AND kind = 'link.opened'`, [A.id])
    expect(opens.rows[0].n).toBe(1)

    const rotated = await request(server).post(`/api/catering/bookings/${booking.id}/agreement/rotate`).set(auth(A.token))
      .send({ confirm_replace: true })
    expect(rotated.status).toBe(200)
    expect(rotated.body.copy_path).toBeTruthy()
    const next = decodeURIComponent(rotated.body.copy_path.replace('/sign/hall/', ''))
    expect(next).not.toBe(token)
    const stale = await request(server).get(`/api/hall-sign/${encodeURIComponent(token)}`)
    expect(stale.status).toBe(404)
    const staffRotate = await request(server).post(`/api/catering/bookings/${booking.id}/agreement/rotate`).set(auth(staff.token))
    expect(staffRotate.status).toBe(403)
  })

  it('voids every agreement when a hold is released, and a signed one needs an admin confirm', async () => {
    const hall = (await pool.query(`SELECT id FROM ochr_cat_spaces WHERE organization_id = $1 AND name = 'Fellowship Hall'`, [A.id])).rows[0]
    const made = await book(A, {
      space_id: hall.id, event_kind: 'hall_rental', host_name: 'Release me',
      starts_at: '2026-12-12T15:00:00.000Z', ends_at: '2026-12-12T17:00:00.000Z',
    })
    expect(made.status).toBe(201)
    const draft = await request(server).post(`/api/catering/bookings/${made.body.id}/agreement`).set(auth(A.token)).send({
      milestones: undefined,
    })
    // milestones were not saved on this booking; save a line first
    await request(server).put(`/api/catering/bookings/${made.body.id}/milestones`).set(auth(A.token)).send({
      milestones: [{ kind: 'hall_rental', amount: '1.00', due_on: '2026-12-01' }],
    })
    const prepared = await request(server).post(`/api/catering/bookings/${made.body.id}/agreement`).set(auth(A.token))
    expect(prepared.status).toBe(201)
    const sent = await request(server).post(`/api/catering/bookings/${made.body.id}/agreement/send`).set(auth(A.token))
      .send({ contract_sha256: prepared.body.contract_sha256 })
    expect(sent.status).toBe(200)
    const token = decodeURIComponent(sent.body.copy_path.replace('/sign/hall/', ''))
    const declined = await request(server).post(`/api/hall-sign/${encodeURIComponent(token)}/decline`).send({ reason: 'Not this date' })
    expect(declined.status).toBe(200)
    const second = await request(server).post(`/api/catering/bookings/${made.body.id}/agreement`).set(auth(A.token))
    expect(second.status).toBe(201)
    const voided = await request(server).post(`/api/catering/bookings/${made.body.id}/agreement/void`).set(auth(A.token))
      .send({ reason: 'Start again' })
    expect(voided.status).toBe(200)
    const left = await pool.query(
      `SELECT status, token_hash FROM ochr_cat_agreements WHERE organization_id = $1 AND booking_id = $2`,
      [A.id, made.body.id])
    expect(left.rows.every(r => r.status === 'voided' && r.token_hash == null)).toBe(true)

    const signedHold = await book(A, {
      space_id: hall.id, event_kind: 'fellowship_dinner', host_name: 'Signed release',
      starts_at: '2026-12-13T15:00:00.000Z', ends_at: '2026-12-13T17:00:00.000Z',
    })
    await request(server).put(`/api/catering/bookings/${signedHold.body.id}/milestones`).set(auth(A.token)).send({
      milestones: [{ kind: 'hall_rental', amount: '2.00', due_on: '2026-12-01' }],
    })
    const prep = await request(server).post(`/api/catering/bookings/${signedHold.body.id}/agreement`).set(auth(A.token))
    const sent2 = await request(server).post(`/api/catering/bookings/${signedHold.body.id}/agreement/send`).set(auth(A.token))
      .send({ contract_sha256: prep.body.contract_sha256 })
    const token2 = decodeURIComponent(sent2.body.copy_path.replace('/sign/hall/', ''))
    const opened = await request(server).get(`/api/hall-sign/${encodeURIComponent(token2)}`)
    await request(server).post(`/api/hall-sign/${encodeURIComponent(token2)}/sign`).send({
      signer_name: 'Bea Sample', accepted: opened.body.consent.map(p => p.id), locale: 'en',
    })
    const staffCancel = await request(server).post(`/api/catering/bookings/${signedHold.body.id}/cancel`).set(auth(staff.token))
    expect(staffCancel.status).toBe(403)
    const noConfirm = await request(server).post(`/api/catering/bookings/${signedHold.body.id}/cancel`).set(auth(A.token)).send({})
    expect(noConfirm.status).toBe(409)
    expect(noConfirm.body.code).toBe('confirm_signed')
    const quietVoid = await request(server).post(`/api/catering/bookings/${signedHold.body.id}/agreement/void`).set(auth(A.token))
      .send({ reason: 'oops' })
    expect(quietVoid.status).toBe(409)
    const released = await request(server).post(`/api/catering/bookings/${signedHold.body.id}/cancel`).set(auth(A.token))
      .send({ confirm_signed: true })
    expect(released.status).toBe(200)
    expect(released.body.status).toBe('cancelled')
    const dead = await request(server).get(`/api/hall-sign/${encodeURIComponent(token2)}`)
    expect(dead.status).toBe(404)
    const after = await pool.query(
      `SELECT status, token_hash FROM ochr_cat_agreements WHERE organization_id = $1 AND booking_id = $2`,
      [A.id, signedHold.body.id])
    expect(after.rows.every(r => r.status === 'voided' && r.token_hash == null)).toBe(true)
  })

  it('refuses send and sign unless the hold is still held, and an expired link cannot decline or be reread', async () => {
    const hall = (await pool.query(`SELECT id FROM ochr_cat_spaces WHERE organization_id = $1 AND name = 'Fellowship Hall'`, [A.id])).rows[0]
    const made = await book(A, {
      space_id: hall.id, event_kind: 'hall_rental', host_name: 'Must stay held',
      starts_at: '2026-12-20T15:00:00.000Z', ends_at: '2026-12-20T16:00:00.000Z',
    })
    await request(server).put(`/api/catering/bookings/${made.body.id}/milestones`).set(auth(A.token)).send({
      milestones: [{ kind: 'hall_rental', amount: '3.00', due_on: '2026-12-01' }],
    })
    const prep = await request(server).post(`/api/catering/bookings/${made.body.id}/agreement`).set(auth(A.token))
    await request(server).post(`/api/catering/bookings/${made.body.id}/cancel`).set(auth(A.token))
    const sent = await request(server).post(`/api/catering/bookings/${made.body.id}/agreement/send`).set(auth(A.token))
      .send({ contract_sha256: prep.body.contract_sha256 })
    expect(sent.status).toBe(409)
    expect(sent.body.code).toBe('not_held')

    const live = await book(A, {
      space_id: hall.id, event_kind: 'hall_rental', host_name: 'Expires',
      starts_at: '2026-12-21T15:00:00.000Z', ends_at: '2026-12-21T16:00:00.000Z',
    })
    await request(server).put(`/api/catering/bookings/${live.body.id}/milestones`).set(auth(A.token)).send({
      milestones: [{ kind: 'hall_rental', amount: '4.00', due_on: '2026-12-01' }],
    })
    const prep2 = await request(server).post(`/api/catering/bookings/${live.body.id}/agreement`).set(auth(A.token))
    const sent2 = await request(server).post(`/api/catering/bookings/${live.body.id}/agreement/send`).set(auth(A.token))
      .send({ contract_sha256: prep2.body.contract_sha256 })
    const token = decodeURIComponent(sent2.body.copy_path.replace('/sign/hall/', ''))
    await pool.query(
      `UPDATE ochr_cat_agreements SET sent_at = NOW() - INTERVAL '31 days' WHERE organization_id = $1 AND booking_id = $2`,
      [A.id, live.body.id])
    const decline = await request(server).post(`/api/hall-sign/${encodeURIComponent(token)}/decline`).send({ reason: 'Too late' })
    expect(decline.status).toBe(410)
    const opened = await request(server).get(`/api/hall-sign/${encodeURIComponent(token)}`)
    const sign = await request(server).post(`/api/hall-sign/${encodeURIComponent(token)}/sign`).send({
      signer_name: 'Cara Sample', accepted: opened.body?.consent?.map(p => p.id) || ['effect'], locale: 'en',
    })
    expect(sign.status).toBe(410)

    // SP-247: signed view expiry uses max(signed_at, sent_at). Both clocks
    // must be past the TTL for the signed record to refuse a reread.
    await pool.query(
      `UPDATE ochr_cat_agreements SET sent_at = NOW() - INTERVAL '31 days', status = 'signed',
             signed_at = NOW() - INTERVAL '31 days', signer_name = 'Cara Sample'
        WHERE organization_id = $1 AND booking_id = $2`,
      [A.id, live.body.id])
    const reread = await request(server).get(`/api/hall-sign/${encodeURIComponent(token)}`)
    expect(reread.status).toBe(410)
  })

  it('rate-limits the signing link and lists each method and path exactly', async () => {
    const allow = readFileSync(new URL('./routeAuthAllowlist.test.js', import.meta.url), 'utf8')
    const appSrc = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
    expect(allow).not.toMatch(/\['\/api\/hall-sign',/)
    expect(appSrc).not.toMatch(/app\.use\('\/api\/hall-sign'/)
    expect(appSrc).toMatch(/\/api\/hall-sign\/:token'/)
    let limited = 0
    for (let i = 0; i < 40; i++) {
      const res = await request(server).get('/api/hall-sign/not-a-real-token')
      if (res.status === 429) { limited = i + 1; break }
    }
    expect(limited).toBeGreaterThan(0)
  })

  it('writes the agreement in the parish clock, names the zone, and localizes due dates', () => {
    const built = buildMilestoneScheduleAndContract({
      eventKind: 'wedding', hostName: 'Ada and Ben', spaceName: 'Sanctuary',
      parishName: 'Synthetic Hall Parish', timeZone: 'America/Los_Angeles',
      startsAt: '2026-11-08T00:00:00.000Z', endsAt: '2026-11-08T06:00:00.000Z',
      milestones: [
        { kind: 'date_hold', amount: '10.10', due_on: '2026-10-01' },
        { kind: 'hall_rental', amount: '14.90', due_on: '2026-10-15' },
      ],
    })
    expect(built.ok).toBe(true)
    expect(built.contract.en).toMatch(/Synthetic Hall Parish/)
    expect(built.contract.en).toMatch(/Nov 7/)
    expect(built.contract.en).not.toMatch(/Nov 8/)
    expect(built.contract.en).toMatch(/\$10\.10/)
    expect(built.contract.en).toMatch(/\$25\.00/)
    expect(built.contract.en).toMatch(/Wedding/)
    expect(built.contract.en).not.toMatch(/not part of this agreement/)
    expect(built.contract.en).toMatch(/Synthetic counsel wording \(en\): cancellation\./)
    expect(built.contract.en).toMatch(/\(America\/Los_Angeles time\)/)
    expect(built.contract.en).toMatch(/due October 1, 2026\./)
    expect(built.contract.en).not.toMatch(/2026-10-01/)
    expect(built.contract.en.match(/Nothing is charged/g)).toHaveLength(1)
    expect(built.contract.es).toMatch(/Boda/)
    expect(built.contract.es).toMatch(/7 nov/i)
    expect(built.contract.es).not.toMatch(/8 nov/i)
    expect(built.contract.es).toMatch(/hora de America\/Los_Angeles/)
    expect(built.contract.es).toMatch(/vencimiento el 1 de octubre de 2026\./)
    expect(built.contract.es.match(/Firmar no cobra nada/g)).toHaveLength(1)
    expect(built.contract.es).toMatch(/Synthetic counsel wording \(es\)/)
  })

  it('says when no parish zone is set instead of passing UTC off as the parish clock', () => {
    const built = buildMilestoneScheduleAndContract({
      eventKind: 'wedding', hostName: 'Ada and Ben', spaceName: 'Hall',
      startsAt: '2026-11-08T00:00:00.000Z', endsAt: '2026-11-08T06:00:00.000Z',
      milestones: [{ kind: 'date_hold', amount: '10.10', due_on: '2026-10-01' }],
    })
    expect(built.snapshot.time_zone).toBeNull()
    expect(built.contract.en).toMatch(/time zone not set; shown in UTC/)
    expect(built.contract.es).toMatch(/zona horaria sin fijar; se muestra en UTC/)
  })

  it('SP-224: a calendar Mass on a Sunday warns a non-sanctuary room', () => {
    const judged = judgeCalendarRow({
      space: { name: 'Fellowship Hall', space_kind: 'fellowship_hall' },
      bookingStart: new Date('2026-11-29T10:00:00.000Z'),
      bookingEnd: new Date('2026-11-29T12:00:00.000Z'),
      timeZone: 'UTC',
      row: { title: 'First Sunday of Advent Mass', date: '2026-11-29', start_time: '10:30:00', end_time: '11:30:00', type: 'mass' },
    })
    expect(judged.warning).toEqual({ source: 'calendar', title: 'First Sunday of Advent Mass', date: '2026-11-29', during: 'sunday_mass' })
    const weekday = judgeCalendarRow({
      space: { name: 'Fellowship Hall', space_kind: 'fellowship_hall' },
      bookingStart: new Date('2026-11-30T10:00:00.000Z'),
      bookingEnd: new Date('2026-11-30T12:00:00.000Z'),
      timeZone: 'UTC',
      row: { title: 'Weekday Mass', date: '2026-11-30', start_time: '10:30:00', end_time: '11:30:00', type: 'mass' },
    })
    expect(weekday.warning).toBeUndefined()
  })

  it('does not let the couple\'s own marriage or a voided marriage block the room, and names All Saints', async () => {
    const sanctuary = (await pool.query(`SELECT id FROM ochr_cat_spaces WHERE organization_id = $1 AND name = 'Sanctuary'`, [A.id])).rows[0]
    const { rows: [own] } = await pool.query(
      `INSERT INTO ochr_sacramental_records (organization_id, type, date, place, member_name)
       VALUES ($1, 'marriage', '2026-11-14', 'Sanctuary', 'Own Couple') RETURNING id`, [A.id])
    const withOwn = await book(A, {
      space_id: sanctuary.id, event_kind: 'wedding', host_name: 'Own Couple',
      marriage_record_id: own.id,
      starts_at: '2026-11-14T20:00:00.000Z', ends_at: '2026-11-14T21:00:00.000Z',
    })
    expect(withOwn.status).toBe(201)
    await pool.query(
      `INSERT INTO ochr_sacramental_records (organization_id, type, date, place, member_name, voided_at, voided_reason)
       VALUES ($1, 'marriage', '2026-11-21', 'Sanctuary', 'Voided Couple', NOW(), 'entered in error')`, [A.id])
    const voided = await book(A, {
      space_id: sanctuary.id, event_kind: 'wedding', host_name: 'After a void',
      starts_at: '2026-11-21T20:00:00.000Z', ends_at: '2026-11-21T21:00:00.000Z',
    })
    expect(voided.status).toBe(201)

    const hall = (await pool.query(`SELECT id FROM ochr_cat_spaces WHERE organization_id = $1 AND name = 'Fellowship Hall'`, [A.id])).rows[0]
    const sunday = await book(A, {
      space_id: hall.id, event_kind: 'fellowship_dinner', host_name: 'During Mass',
      starts_at: '2026-11-15T10:30:00.000Z', ends_at: '2026-11-15T12:00:00.000Z',
    })
    expect(sunday.status).toBe(201)
    expect(sunday.body.warnings?.some(w => w.during === 'sunday_mass')).toBe(true)

    await pool.query(`DELETE FROM ochr_liturgical_calendar WHERE date = '2026-11-01'`)
    const saints = await book(A, {
      space_id: hall.id, event_kind: 'fellowship_dinner', host_name: 'All Saints supper',
      starts_at: '2026-11-01T18:00:00.000Z', ends_at: '2026-11-01T20:00:00.000Z',
    })
    expect(saints.status).toBe(201)
    expect(saints.body.liturgical_status).toBe('known')
    expect(saints.body.liturgical.some(d => d.feast_name === 'All Saints')).toBe(true)
  })

  it('lets a parish with a hall agreement be deleted, and token hashes are unique', async () => {
    const org = await signup('delete')
    const room = await space(org, 'Hall', 'fellowship_hall')
    const made = await book(org, {
      space_id: room.id, event_kind: 'hall_rental', host_name: 'Going away',
      starts_at: '2026-12-28T15:00:00.000Z', ends_at: '2026-12-28T16:00:00.000Z',
    })
    await request(server).put(`/api/catering/bookings/${made.body.id}/milestones`).set(auth(org.token)).send({
      milestones: [{ kind: 'hall_rental', amount: '1.00', due_on: '2026-12-01' }],
    })
    const prep = await request(server).post(`/api/catering/bookings/${made.body.id}/agreement`).set(auth(org.token))
    await request(server).post(`/api/catering/bookings/${made.body.id}/agreement/send`).set(auth(org.token))
      .send({ contract_sha256: prep.body.contract_sha256 })
    await expect(pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.id])).resolves.toBeTruthy()

    const hash = 'a'.repeat(64)
    const { rows: [spaceRow] } = await pool.query(
      `SELECT id FROM ochr_cat_spaces WHERE organization_id = $1 LIMIT 1`, [A.id])
    const { rows: [b1] } = await pool.query(
      `INSERT INTO ochr_cat_bookings (organization_id, space_id, event_kind, host_name, starts_at, ends_at, vertical_key)
       VALUES ($1,$2,'hall_rental','Hash one','2027-01-02T15:00:00Z','2027-01-02T16:00:00Z','open-church') RETURNING id`,
      [A.id, spaceRow.id])
    await pool.query(
      `INSERT INTO ochr_cat_agreements (organization_id, booking_id, status, contract_en, contract_es, contract_sha256, token_hash)
       VALUES ($1,$2,'sent','en','es','abc',$3)`, [A.id, b1.id, hash])
    const { rows: [b2] } = await pool.query(
      `INSERT INTO ochr_cat_bookings (organization_id, space_id, event_kind, host_name, starts_at, ends_at, vertical_key)
       VALUES ($1,$2,'hall_rental','Hash two','2027-01-03T15:00:00Z','2027-01-03T16:00:00Z','open-church') RETURNING id`,
      [A.id, spaceRow.id])
    await expect(pool.query(
      `INSERT INTO ochr_cat_agreements (organization_id, booking_id, status, contract_en, contract_es, contract_sha256, token_hash)
       VALUES ($1,$2,'sent','en','es','abc',$3)`, [A.id, b2.id, hash])).rejects.toThrow(/ochr_cat_agreements_token_hash|duplicate key/i)
  })
})
