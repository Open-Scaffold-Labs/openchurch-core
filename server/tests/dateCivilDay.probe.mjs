// One process, one TZ. Prints { ok: true } or exits 1 with the mismatches.
// Spawned by dateCivilDay.test.js under UTC, America/Los_Angeles, and
// Pacific/Auckland. The parser lives in db.js, which this imports first.

import request from 'supertest'
import pool from '../src/db.js'
import { migrateOnce, bindServer, closeServer } from './support/harness.js'
import { createOrg } from './support/provision.js'

const DAY = '2026-09-27'
const fails = []

function check(name, value, extra) {
  if (value !== DAY) fails.push({ name, value: value ?? null, ...extra })
}

const auth = (t) => ({ Authorization: `Bearer ${t}` })

await migrateOnce()
const server = await bindServer()
let orgId = null
try {
  const { rows } = await pool.query(`SELECT '2026-09-27'::date AS d, ARRAY['2026-09-27'::date] AS days`)
  check('sql', rows[0].d)
  check('sql-json', JSON.parse(JSON.stringify(rows[0])).d)
  const days = rows[0].days
  if (!Array.isArray(days) || days[0] !== DAY) fails.push({ name: 'sql.date[]', value: days ?? null })
  const daysJson = JSON.parse(JSON.stringify(rows[0])).days
  if (!Array.isArray(daysJson) || daysJson[0] !== DAY) fails.push({ name: 'sql.date[].json', value: daysJson ?? null })

  const arrays = await pool.query(`
    SELECT '{}'::date[] AS empty,
           ARRAY['2026-09-27'::date, NULL::date, '2026-09-28'::date] AS with_null,
           ARRAY[
             ARRAY['2026-09-27'::date, '2026-09-28'::date],
             ARRAY['2026-10-03'::date, NULL::date]
           ] AS grid
  `)
  const parsed = JSON.parse(JSON.stringify(arrays.rows[0]))
  if (JSON.stringify(parsed.empty) !== '[]') fails.push({ name: 'sql.date[].empty', value: parsed.empty })
  if (JSON.stringify(parsed.with_null) !== JSON.stringify(['2026-09-27', null, '2026-09-28'])) {
    fails.push({ name: 'sql.date[].null', value: parsed.with_null })
  }
  if (JSON.stringify(parsed.grid) !== JSON.stringify([['2026-09-27', '2026-09-28'], ['2026-10-03', null]])) {
    fails.push({ name: 'sql.date[].2d', value: parsed.grid })
  }

  const signup = await createOrg(server, {
    organizationName: `Civil Day ${process.env.TZ} ${Date.now()}`,
    name: 'Admin',
    email: `civil_${String(process.env.TZ).replace(/[^a-z0-9]/gi, '_')}_${Date.now()}@example.com`,
    password: 'civil-day-pw-1',
  })
  if (signup.status !== 201) {
    fails.push({ name: 'signup', value: signup.status, body: signup.body })
  } else {
    orgId = signup.body.user.organization.id
    const token = signup.body.token

    const ev = await request(server).post('/api/events').set(auth(token))
      .send({ title: 'Sunday service', date: DAY, time: '10:00' })
    check('events.post', ev.body?.date, { status: ev.status })
    const evList = await request(server).get('/api/events').set(auth(token))
    const evRow = (Array.isArray(evList.body) ? evList.body : []).find(e => e.title === 'Sunday service')
    check('events.get', evRow?.date, { status: evList.status })

    const cal = await request(server).post('/api/calendar').set(auth(token))
      .send({ title: 'Sunday Mass', date: DAY, start_time: '10:00', end_time: '11:00', type: 'service' })
    check('calendar.post', cal.body?.date, { status: cal.status })
    const calList = await request(server).get(`/api/calendar?start=${DAY}&end=${DAY}`).set(auth(token))
    const calRow = (Array.isArray(calList.body) ? calList.body : []).find(e => e.title === 'Sunday Mass')
    check('calendar.list', calRow?.date, { status: calList.status })

    const task = await request(server).post('/api/tasks').set(auth(token))
      .send({ title: 'Prepare the books', category: 'DAILY_OPS', due_date: DAY })
    check('tasks.post', task.body?.due_date, { status: task.status })

    const member = await request(server).post('/api/clients').set(auth(token))
      .send({ name: 'Ada Civil', birth_date: DAY, joined_date: DAY })
    check('clients.birth_date', member.body?.birth_date, { status: member.status })
    check('clients.joined_date', member.body?.joined_date, { status: member.status })

    const gift = await request(server).post('/api/donations').set(auth(token))
      .send({ donor_name: 'Civil Donor', amount: 10, date: DAY, category: 'General', method: 'cash' })
    check('donations.post', gift.body?.date, { status: gift.status })

    const preview = await request(server).get('/api/giving-statements/donor')
      .set(auth(token)).query({ year: 2026, key: 'Civil Donor', by: 'name' })
    check('statement.preview', preview.body?.lines?.[0]?.date, { status: preview.status })

    const issued = await request(server).post('/api/giving-statements/issue').set(auth(token))
      .send({ year: 2026, key: 'Civil Donor', by: 'name', issue_key: `civil-${process.env.TZ}-${Date.now()}` })
    const statement = issued.body?.statement
    check('statement.snapshot', statement?.snapshot_json?.lines?.[0]?.date, { status: issued.status })
    if (statement && statement.snapshot_version !== 2) {
      fails.push({ name: 'statement.snapshot_version', value: statement.snapshot_version ?? null })
    }
    if (statement && statement.snapshot_json?.snapshot_version !== 2) {
      fails.push({ name: 'statement.snapshot_json.snapshot_version', value: statement.snapshot_json?.snapshot_version ?? null })
    }
  }
} catch (err) {
  fails.push({ name: 'threw', value: err?.message || String(err) })
} finally {
  if (orgId) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
}

if (fails.length) {
  console.error(JSON.stringify({ tz: process.env.TZ, fails }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ tz: process.env.TZ, ok: true, day: DAY }))
