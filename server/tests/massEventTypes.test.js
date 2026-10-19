// Which calendar rows can take an intention.
//
// The Schedule form writes three types: service, event, meeting.
// meeting is the only clearly non-liturgical one, so it is refused.
// Everything else is accepted, because production's mix is UNKNOWN
// and the column default / omitted POST type is event.
//
//   service — accepted. Form default, sample seed, St. Brigid, diocese
//             demo, scale drill. Listed first in Assign.
//   mass    — accepted. POST stores the word. Listed first.
//   event   — accepted. Column default, omitted/null/blank POST, and
//             the Event pill. Listed under Other calendar entries.
//   liturgy — accepted. No writer. POST keeps the word.
//   null    — accepted. No writer stores it. An INSERT that sets the
//             column to NULL stays NULL.
//   meeting — refused. Schedule Meeting pill. Nothing is written.
//
// CSV import, ICS, the AI tools, the Sunday Packet, and the liturgical
// stamp do not insert ochr_calendar_events. Recurrence copies the
// request type, or event when that type was omitted. The date rule
// is the same for every accepted type: the row's day is stored, and
// a same-event conflict is 409.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { REFUSE_DATE_DISAGREES, REFUSE_NOT_A_MASS } from '../src/routes/massIntentions.js'
import { seedSampleData } from '../src/onboarding/sampleSeed.js'
import { PARISH } from '../src/demo/stBrigids.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let token
let orgId

const DAY = '2034-06-03'

async function postEvent(body) {
  const res = await request(server).post('/api/calendar')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: `Row ${RUN_ID}`, date: DAY, start_time: '10:00', end_time: '11:00', ...body })
  expect(res.status).toBe(201)
  return res.body
}

async function offer(eventId) {
  return request(server).post('/api/mass-intentions')
    .set('Authorization', `Bearer ${token}`)
    .send({ intention: `Offered at ${eventId} ${RUN_ID}`, calendar_event_id: eventId })
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const org = await createOrg(server, {
    organizationName: `Mass Types ${RUN_ID}`,
    name: 'Ada Admin',
    email: `masstype_${RUN_ID}@example.com`,
    password: 'masstype-test-pw-1',
  }, '10.99.88.31')
  expect(org.status).toBe(201)
  token = org.body.token
  orgId = org.body.user.organization.id
})

afterAll(async () => {
  await closeServer(server)
})

describe('calendar create paths and the Mass-only rule', () => {
  it('Schedule default, diocese demo, and scale-drill: type service accepts an intention', async () => {
    const row = await postEvent({ title: `Sunday Mass ${RUN_ID}`, type: 'service' })
    expect(row.type).toBe('service')
    const offered = await offer(row.id)
    expect(offered.status).toBe(201)
    expect(offered.body.calendar_event_id).toBe(row.id)

    const { rows } = await pool.query(
      `INSERT INTO ochr_calendar_events (organization_id, title, date, start_time, end_time, type)
       VALUES ($1, $2, '2034-06-10', '10:00', '11:30', 'service') RETURNING id, type`,
      [orgId, `Scale drill shape ${RUN_ID}`],
    )
    expect(rows[0].type).toBe('service')
    const drilled = await offer(rows[0].id)
    expect(drilled.status).toBe(201)
    expect(drilled.body.calendar_event_id).toBe(rows[0].id)
  })

  it('a row stored as type mass accepts an intention', async () => {
    const row = await postEvent({ title: `Misa Dominical ${RUN_ID}`, type: 'mass' })
    expect(row.type).toBe('mass')
    const offered = await offer(row.id)
    expect(offered.status).toBe(201)
    expect(offered.body.calendar_event_id).toBe(row.id)
    expect(offered.body.mass_date).toBe(DAY)

    const word = await postEvent({ title: `Misa ${RUN_ID}`, type: 'Mass' })
    expect(word.type).toBe('Mass')
    const wordOffered = await offer(word.id)
    expect(wordOffered.status).toBe(201)
    expect(wordOffered.body.calendar_event_id).toBe(word.id)
  })

  it('omitting type stores event, and that row can be assigned on its own day', async () => {
    const row = await postEvent({ title: `Untyped ${RUN_ID}` })
    expect(row.type).toBe('event')
    const blank = await postEvent({ title: `Blank type ${RUN_ID}`, type: '' })
    expect(blank.type).toBe('event')
    const absent = await postEvent({ title: `Null type ${RUN_ID}`, type: null })
    expect(absent.type).toBe('event')
    const offered = await offer(row.id)
    expect(offered.status).toBe(201)
    expect(offered.body.calendar_event_id).toBe(row.id)
    expect(offered.body.mass_date).toBe(DAY)
    const conflict = await request(server).patch(`/api/mass-intentions/${offered.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ calendar_event_id: row.id, mass_date: '2034-06-04' })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error).toBe(REFUSE_DATE_DISAGREES)
    const stored = await pool.query(
      `SELECT calendar_event_id, to_char(mass_date, 'YYYY-MM-DD') AS mass_date
         FROM ochr_mass_intentions WHERE id = $1`,
      [offered.body.id],
    )
    expect(stored.rows[0].calendar_event_id).toBe(row.id)
    expect(stored.rows[0].mass_date).toBe(DAY)
    for (const id of [blank.id, absent.id]) {
      const also = await offer(id)
      expect(also.status).toBe(201)
      expect(also.body.mass_date).toBe(DAY)
    }
  })

  it('a recurring series copies service onto each occurrence, and copies event when type is omitted', async () => {
    const series = await postEvent({
      title: `Weekly Mass ${RUN_ID}`,
      type: 'service',
      recurrence: { freq: 'weekly', interval: 1, count: 2 },
    })
    const children = await pool.query(
      `SELECT id, type FROM ochr_calendar_events
        WHERE organization_id = $1 AND recurrence_parent_id = $2 AND id <> $2
        ORDER BY date`,
      [orgId, series.id],
    )
    expect(children.rows).toHaveLength(1)
    expect(children.rows[0].type).toBe('service')
    const offered = await offer(children.rows[0].id)
    expect(offered.status).toBe(201)
    expect(offered.body.calendar_event_id).toBe(children.rows[0].id)

    const bare = await postEvent({
      title: `Weekly untyped ${RUN_ID}`,
      recurrence: { freq: 'weekly', interval: 1, count: 2 },
    })
    const bareChildren = await pool.query(
      `SELECT id, type FROM ochr_calendar_events
        WHERE organization_id = $1 AND recurrence_parent_id = $2 AND id <> $2`,
      [orgId, bare.id],
    )
    expect(bareChildren.rows).toHaveLength(1)
    expect(bare.type).toBe('event')
    expect(bareChildren.rows[0].type).toBe('event')
    const offeredBare = await offer(bareChildren.rows[0].id)
    expect(offeredBare.status).toBe(201)
    expect(offeredBare.body.calendar_event_id).toBe(bareChildren.rows[0].id)
  })

  it('the sample seed Sunday service accepts an intention', async () => {
    const again = await seedSampleData(pool, orgId, 'catholic')
    expect(again).toMatchObject({ skipped: true })
    const { rows } = await pool.query(
      `SELECT id, type, title, recurrence_parent_id
         FROM ochr_calendar_events
        WHERE organization_id = $1 AND title LIKE '[Sample]%'
        ORDER BY date, id`,
      [orgId],
    )
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.every(r => r.type === 'service')).toBe(true)
    const child = rows.find(r => r.recurrence_parent_id != null && r.id !== r.recurrence_parent_id)
    expect(child).toBeTruthy()
    const offered = await offer(child.id)
    expect(offered.status).toBe(201)
    expect(offered.body.calendar_event_id).toBe(child.id)
  })

  it("St. Brigid's seed writes every weekly row as service, including the Eucharist", async () => {
    const org = await createOrg(server, {
      organizationName: PARISH.name,
      name: 'Demo Seeder Admin',
      email: `brigid_${RUN_ID}@example.com`,
      password: 'masstype-test-pw-1',
    }, '10.99.88.32')
    expect(org.status).toBe(201)
    const demoOrg = org.body.user.organization.id
    const run = spawnSync(process.execPath, ['src/demo/seedStBrigids.js', '--org', String(demoOrg)], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: process.env,
      encoding: 'utf8',
    })
    expect(run.status, run.stderr || run.stdout).toBe(0)

    const { rows } = await pool.query(
      `SELECT id, title, type FROM ochr_calendar_events
        WHERE organization_id = $1
        ORDER BY date, start_time`,
      [demoOrg],
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.type === 'service')).toBe(true)
    const eucharist = rows.find(r => r.title === 'Holy Eucharist, Rite I')
    const coffee = rows.find(r => r.title === 'Coffee Hour')
    const vestry = rows.find(r => r.title === 'Vestry Meeting')
    expect(eucharist).toBeTruthy()
    expect(coffee?.type).toBe('service')
    expect(vestry?.type).toBe('service')

    const offered = await request(server).post('/api/mass-intentions')
      .set('Authorization', `Bearer ${org.body.token}`)
      .send({ intention: `At the Eucharist ${RUN_ID}`, calendar_event_id: eucharist.id })
    expect(offered.status).toBe(201)
    expect(offered.body.calendar_event_id).toBe(eucharist.id)
  }, 90_000)

  it('the column default event and a SQL NULL both accept an intention', async () => {
    const omitted = await pool.query(
      `INSERT INTO ochr_calendar_events (organization_id, title, date, start_time, end_time)
       VALUES ($1, $2, '2034-07-01', '10:00', '11:00') RETURNING id, type`,
      [orgId, `Column default ${RUN_ID}`],
    )
    expect(omitted.rows[0].type).toBe('event')
    const nulled = await pool.query(
      `INSERT INTO ochr_calendar_events (organization_id, title, date, start_time, end_time, type)
       VALUES ($1, $2, '2034-07-08', '10:00', '11:00', NULL) RETURNING id, type`,
      [orgId, `Explicit null ${RUN_ID}`],
    )
    expect(nulled.rows[0].type).toBeNull()
    const fromDefault = await offer(omitted.rows[0].id)
    expect(fromDefault.status).toBe(201)
    expect(fromDefault.body.mass_date).toBe('2034-07-01')
    const fromNull = await offer(nulled.rows[0].id)
    expect(fromNull.status).toBe(201)
    expect(fromNull.body.mass_date).toBe('2034-07-08')
  })

  it('event and liturgy can be assigned, and a meeting is refused with nothing written', async () => {
    const picnic = await postEvent({ title: `10:30 Mass ${RUN_ID}`, type: 'event' })
    const liturgy = await postEvent({ title: `Liturgy word ${RUN_ID}`, type: 'liturgy' })
    expect(liturgy.type).toBe('liturgy')
    for (const id of [picnic.id, liturgy.id]) {
      const offered = await offer(id)
      expect(offered.status).toBe(201)
      expect(offered.body.calendar_event_id).toBe(id)
      expect(offered.body.mass_date).toBe(DAY)
    }

    const meeting = await postEvent({ title: `Vestry ${RUN_ID}`, type: 'meeting' })
    const before = await pool.query(
      'SELECT COUNT(*)::int AS c FROM ochr_mass_intentions WHERE organization_id = $1',
      [orgId],
    )
    const refused = await offer(meeting.id)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(REFUSE_NOT_A_MASS)
    const after = await pool.query(
      'SELECT COUNT(*)::int AS c FROM ochr_mass_intentions WHERE organization_id = $1',
      [orgId],
    )
    expect(after.rows[0].c).toBe(before.rows[0].c)
  })
})
