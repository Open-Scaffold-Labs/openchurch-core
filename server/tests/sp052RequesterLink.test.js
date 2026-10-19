// SP-052: Mass Intention requester → member link (same parish only).
// Real PG. Red on removal of: POST id validation (malformed ids were silently
// dropped and the row saved unlinked; true became member 1), and the audit
// rule that records the requester by member id only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { readMemberId } from '../src/routes/massIntentions.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, A, B, viewer, memberA, memberB
const PW = 'sp052-test-pw-0001'
let ip = 10
const nextIp = () => `10.252.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
const NOT_FOUND = { error: 'Member not found in your church' }

async function org(label) {
  const r = await createOrg(server, { organizationName: `SP052 ${label} ${RUN_ID}`, name: `Admin ${label}`, email: `sp052_${label}_${RUN_ID}@example.com`, password: PW }, nextIp())
  expect(r.status).toBe(201)
  return { token: r.body.token, id: r.body.user.organization.id }
}
async function member(o, name) {
  const r = await request(server).post('/api/clients').set(auth(o.token)).send({ name })
  expect(r.status).toBe(201); expect(r.body.id).toBeGreaterThan(0)
  return r.body.id
}
const count = async (o, intention) => (await pool.query('SELECT COUNT(*)::int n FROM ochr_mass_intentions WHERE organization_id=$1 AND intention=$2', [o.id, intention])).rows[0].n
const post = (o, body) => request(server).post('/api/mass-intentions').set(auth(o.token)).send(body)
async function auditFor(orgId, path) {
  for (let i = 0; i < 40; i++) {
    const { rows } = await pool.query('SELECT metadata, summary FROM ochr_audit_log WHERE organization_id=$1 AND request_path=$2 ORDER BY id', [orgId, path])
    if (rows.length) return rows
    await new Promise(r => setTimeout(r, 50))
  }
  return []
}

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  A = await org('a'); B = await org('b')
  memberA = await member(A, 'Synthetic Requester A'); memberB = await member(B, 'Synthetic Requester B')
  const c = await request(server).post('/api/users').set(auth(A.token)).set('X-Forwarded-For', nextIp()).send({ name: 'Synthetic Viewer', email: `sp052_viewer_${RUN_ID}@example.com`, password: PW, role: 'viewer' })
  expect(c.status).toBe(201)
  const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email: `sp052_viewer_${RUN_ID}@example.com`, password: PW })
  viewer = { token: l.body.token }
}, 60_000)
afterAll(async () => { await closeServer(server); await pool.end() })

describe('readMemberId', () => {
  it('accepts only positive integers and their decimal strings', () => {
    expect(readMemberId(7)).toBe(7); expect(readMemberId('42')).toBe(42)
    expect(readMemberId(2147483647)).toBe(2147483647); expect(readMemberId('2147483647')).toBe(2147483647)
    for (const v of [true, false, '', ' 7', '7 ', '1.5', 1.5, 0, -3, '0', '007', '1e2', 'abc', [], {}, NaN, Infinity,
                     2147483648, '2147483648', Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, '9007199254740993', 1e20, '99999999999'])
      expect(Number.isNaN(readMemberId(v)), String(v)).toBe(true)
  })
})

describe('POST /api/mass-intentions requester link', () => {
  it('links a same-parish member', async () => {
    const r = await post(A, { intention: `sp052 ok ${RUN_ID}`, requested_by_client_id: memberA })
    expect(r.status).toBe(201)
    expect(r.body.requested_by_client_id).toBe(memberA)
    expect(r.body.requester_name).toBe('Synthetic Requester A')
  })

  it('other-parish, nonexistent and malformed ids get one identical 404 and nothing is written', async () => {
    const cases = { other: memberB, missing: 2_000_000_000, boolTrue: true, zero: 0, negative: -1, fraction: 1.5, empty: '', word: 'abc', spaced: ` ${memberA}` }
    for (const [label, id] of Object.entries(cases)) {
      const intention = `sp052 refuse ${label} ${RUN_ID}`
      const r = await post(A, { intention, requested_by_client_id: id })
      expect([label, r.status, r.body]).toEqual([label, 404, NOT_FOUND])
      expect(await count(A, intention), label).toBe(0)
    }
  })

  it('PATCH gives the identical answer for the same ids and leaves the row unchanged', async () => {
    const made = await post(A, { intention: `sp052 patch ${RUN_ID}`, requested_by_client_id: memberA })
    for (const id of [memberB, 2_000_000_000, true, 'abc']) {
      const r = await request(server).patch(`/api/mass-intentions/${made.body.id}`).set(auth(A.token)).send({ requested_by_client_id: id })
      expect([String(id), r.status, r.body]).toEqual([String(id), 404, NOT_FOUND])
    }
    const after = await request(server).get(`/api/mass-intentions/${made.body.id}`).set(auth(A.token))
    expect(after.body.requested_by_client_id).toBe(memberA)
    const cleared = await request(server).patch(`/api/mass-intentions/${made.body.id}`).set(auth(A.token)).send({ requested_by_client_id: null })
    expect(cleared.status).toBe(200); expect(cleared.body.requested_by_client_id).toBeNull()
  })

  it('a viewer cannot set the link (403)', async () => {
    const intention = `sp052 viewer ${RUN_ID}`
    const r = await post(viewer, { intention, requested_by_client_id: memberA })
    expect(r.status).toBe(403); expect(await count(A, intention)).toBe(0)
  })

  it('the DB backstop refuses a cross-parish link written directly', async () => {
    await expect(pool.query('INSERT INTO ochr_mass_intentions (organization_id, intention, requested_by_client_id) VALUES ($1, $2, $3)', [A.id, `sp052 sql ${RUN_ID}`, memberB]))
      .rejects.toMatchObject({ code: '23503' })
  })

  it('R285-1: out-of-int4 and unsafe ids get the common 404 on POST and PATCH; no write, no success audit', async () => {
    const made = await post(A, { intention: `sp052 range base ${RUN_ID}`, requested_by_client_id: memberA })
    expect(made.status).toBe(201)
    const auditCount = async () => (await pool.query('SELECT COUNT(*)::int n FROM ochr_audit_log WHERE organization_id=$1 AND entity_type=$2', [A.id, 'mass_intention'])).rows[0].n
    await auditFor(A.id, '/api/mass-intentions')
    await new Promise(r => setTimeout(r, 200))
    const before = await auditCount()
    for (const id of [2147483648, '2147483648', Number.MAX_VALUE, '9007199254740993', 9007199254740992, 1e20, '99999999999']) {
      const intention = `sp052 range ${String(id)} ${RUN_ID}`
      const r = await post(A, { intention, requested_by_client_id: id })
      expect([String(id), r.status, r.body]).toEqual([String(id), 404, NOT_FOUND])
      expect(await count(A, intention)).toBe(0)
      const p = await request(server).patch(`/api/mass-intentions/${made.body.id}`).set(auth(A.token)).send({ requested_by_client_id: id })
      expect([String(id), p.status, p.body]).toEqual([String(id), 404, NOT_FOUND])
    }
    const still = await request(server).get(`/api/mass-intentions/${made.body.id}`).set(auth(A.token))
    expect(still.body.requested_by_client_id).toBe(memberA)
    await new Promise(r => setTimeout(r, 200))
    expect(await auditCount()).toBe(before)
  })
})

describe('R285-2 GET /api/clients/picker', () => {
  it('returns only {id, name} for the session parish, name match only, bounded', async () => {
    await pool.query("UPDATE ochr_clients SET email='synthetic.contact@example.com', phone='5550100', notes='Synthetic note' WHERE id=$1", [memberA])
    const r = await request(server).get('/api/clients/picker?search=Synthetic%20Requester').set(auth(A.token))
    expect(r.status).toBe(200)
    expect(r.body).toEqual([{ id: memberA, name: 'Synthetic Requester A' }])
    for (const row of r.body) expect(Object.keys(row).sort()).toEqual(['id', 'name'])
    expect(JSON.stringify(r.body)).not.toMatch(/example\.com|5550100|Synthetic note|Requester B/)
    const byEmail = await request(server).get('/api/clients/picker?search=synthetic.contact').set(auth(A.token))
    expect(byEmail.body).toEqual([])
    const wild = await request(server).get('/api/clients/picker?search=%25').set(auth(A.token))
    expect(wild.status).toBe(200); expect(wild.body).toEqual([])
    const big = await request(server).get('/api/clients/picker?limit=100000&columns=email').set(auth(A.token))
    expect(big.status).toBe(200); expect(big.body.length).toBeLessThanOrEqual(25)
    for (const row of big.body) expect(Object.keys(row).sort()).toEqual(['id', 'name'])
    const other = await request(server).get('/api/clients/picker?search=Requester').set(auth(B.token))
    expect(other.body).toEqual([{ id: memberB, name: 'Synthetic Requester B' }])
  })
  it('requires a session', async () => {
    expect((await request(server).get('/api/clients/picker')).status).toBe(401)
  })
})

describe('R285-3 audit is a closed id-only projection', () => {
  const ALLOWED = ['intention_id', 'requested_by_client_id', 'calendar_event_id', 'status', 'op', 'link', 'changed', 'stipend_before', 'stipend_after']
  const rowsFor = async id => {
    for (let i = 0; i < 40; i++) {
      const { rows } = await pool.query("SELECT action, entity_type, entity_id, summary, metadata FROM ochr_audit_log WHERE organization_id=$1 AND entity_type='mass_intention' AND entity_id=$2 ORDER BY id", [A.id, String(id)])
      if (rows.length) return rows
      await new Promise(r => setTimeout(r, 50))
    }
    return []
  }
  it('create/link/unlink rows carry only typed ids from the handled resource; text stays on the row', async () => {
    const body = { intention: 'For Synthetic Alice', note: 'Synthetic Alice note', requested_by: 'Synthetic Alice',
      requested_by_client_id: String(memberA), nested: { requester_name: 'Synthetic Alice' }, unknown_key: 'Synthetic Alice', intention_id: 999999, status: 'open', stipend: 10 }
    const c = await post(A, body)
    expect(c.status).toBe(201)
    const id = Number(c.body.id)
    const u1 = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send({ requested_by_client_id: null, note: 'Synthetic Alice again', nested: { name: 'Synthetic Alice' } })
    expect(u1.status).toBe(200)
    await new Promise(r => setTimeout(r, 150))
    const u2 = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send({ requested_by_client_id: String(memberA) })
    expect(u2.status).toBe(200)
    const u3 = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send({ status: 'cancelled', intention: 'For Synthetic Alice (edited)' })
    expect(u3.status).toBe(200)
    let rows = []
    for (let i = 0; i < 40 && rows.length < 4; i++) { rows = await rowsFor(id); if (rows.length < 4) await new Promise(r => setTimeout(r, 50)) }
    expect(rows.map(r => r.action)).toEqual(['create', 'update', 'update', 'update'])
    for (const r of rows) {
      expect(Object.keys(r.metadata).every(k => ALLOWED.includes(k)), JSON.stringify(r.metadata)).toBe(true)
      expect(JSON.stringify(r)).not.toMatch(/Alice/)
      expect(String(r.entity_id)).toBe(String(id))
      expect(r.metadata.intention_id).toBe(id)
    }
    expect(rows[0].metadata).toMatchObject({ intention_id: id, requested_by_client_id: memberA, status: 'open' })
    expect(rows[0].metadata).not.toHaveProperty('link')
    expect(rows[1].metadata).toMatchObject({ requested_by_client_id: null, link: 'unlinked' })
    expect(rows[2].metadata).toMatchObject({ requested_by_client_id: memberA, link: 'linked' })
    expect(rows[3].metadata).toMatchObject({ status: 'cancelled' }); expect(rows[3].metadata).not.toHaveProperty('link')
    const stored = (await pool.query('SELECT intention, note, requested_by FROM ochr_mass_intentions WHERE id=$1', [id])).rows[0]
    expect(stored).toEqual({ intention: 'For Synthetic Alice (edited)', note: 'Synthetic Alice again', requested_by: 'Synthetic Alice' })
  })
})

// R285-F1 / F2 (Carolina, #285 at d4c89824): an edit's audit row names the
// fields whose stored value changed (closed allowlist, no text), stipend
// carries numeric before/after, and the link label is written only on a
// real change of the stored member id.
describe('R285-F1/F2 audit names what changed, truthfully', () => {
  const patch = (id, body) => request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send(body)
  const updates = async (id, n) => {
    let rows = []
    for (let i = 0; i < 60; i++) {
      rows = (await pool.query("SELECT metadata FROM ochr_audit_log WHERE organization_id=$1 AND entity_type='mass_intention' AND entity_id=$2 AND action='update' AND NOT (metadata ? 'op') ORDER BY id", [A.id, String(id)])).rows
      if (rows.length >= n) break
      await new Promise(r => setTimeout(r, 50))
    }
    return rows.map(r => r.metadata)
  }
  const settle = () => new Promise(r => setTimeout(r, 120))

  it('F1: stipend edit on a fulfilled intention records the field and numeric before/after; text edits record names only', async () => {
    const mass = await request(server).post('/api/calendar').set(auth(A.token)).send({ title: `Sunday Mass F1 ${RUN_ID}`, date: '2027-06-13', start_time: '10:00', end_time: '11:00', type: 'service' })
    expect(mass.status).toBe(201)
    const c = await post(A, { intention: 'For Synthetic Bruno', requested_by: 'Synthetic Bruno', stipend: 15 })
    expect(c.status).toBe(201)
    const id = Number(c.body.id)
    expect((await request(server).post(`/api/mass-intentions/${id}/assign`).set(auth(A.token)).send({ calendar_event_id: mass.body.id })).status).toBe(200)
    expect((await patch(id, { status: 'fulfilled' })).status).toBe(200); await settle()
    expect((await patch(id, { stipend: 99 })).status).toBe(200); await settle()
    expect((await patch(id, { intention: 'For Synthetic Bruno (edited)' })).status).toBe(200); await settle()
    expect((await patch(id, { note: 'Synthetic Bruno note' })).status).toBe(200)
    const rows = await updates(id, 4)
    expect(rows).toHaveLength(4)
    const [fulfil, stip, text, note] = rows
    expect(fulfil.changed).toEqual(['status'])
    expect(stip).toMatchObject({ changed: ['stipend'], stipend_before: 15, stipend_after: 99, status: 'fulfilled' })
    expect(text.changed).toEqual(['intention'])
    expect(note.changed).toEqual(['note'])
    for (const m of [fulfil, text, note]) { expect(m).not.toHaveProperty('stipend_before'); expect(m).not.toHaveProperty('stipend_after'); expect(m).not.toHaveProperty('link') }
    expect(JSON.stringify(rows)).not.toMatch(/Bruno/)
  })

  it('F2: re-sending the same member id is not "linked"; null on an unlinked row is not "unlinked"', async () => {
    const c = await post(A, { intention: 'For Synthetic Carla', requested_by_client_id: memberA })
    expect(c.status).toBe(201)
    const id = Number(c.body.id)
    expect((await patch(id, { requested_by_client_id: memberA })).status).toBe(200); await settle()
    expect((await patch(id, { requested_by_client_id: null })).status).toBe(200); await settle()
    expect((await patch(id, { requested_by_client_id: null })).status).toBe(200); await settle()
    expect((await patch(id, { requested_by_client_id: String(memberA) })).status).toBe(200)
    const rows = await updates(id, 4)
    expect(rows).toHaveLength(4)
    expect(rows[0]).not.toHaveProperty('link'); expect(rows[0].changed).toEqual([])
    expect(rows[1]).toMatchObject({ link: 'unlinked', changed: ['requested_by_client_id'], requested_by_client_id: null })
    expect(rows[2]).not.toHaveProperty('link'); expect(rows[2].changed).toEqual([])
    expect(rows[3]).toMatchObject({ link: 'linked', changed: ['requested_by_client_id'], requested_by_client_id: memberA })
  })
})

// R285-4 (TARS on #285 at 1fd2e0f2): a PATCH's audit row must describe THIS
// request's committed UPDATE, not a later re-read. Real Postgres, controlled
// barrier: A commits, then is held before its post-COMMIT loadFull while
// writer B relinks/reschedules the same row. A's audit must still say what A
// committed; B's audit says what B committed.
describe('R285-4 audit is bound to the committed RETURNING snapshot', () => {
  const patch = (id, body) => request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send(body)
  const updatesFor = async (id, n) => {
    let rows = []
    for (let i = 0; i < 80; i++) {
      rows = (await pool.query("SELECT metadata FROM ochr_audit_log WHERE organization_id=$1 AND entity_type='mass_intention' AND entity_id=$2 AND action='update' AND NOT (metadata ? 'op') ORDER BY id", [A.id, String(id)])).rows
      if (rows.length >= n) break
      await new Promise(r => setTimeout(r, 50))
    }
    return rows.map(r => r.metadata)
  }

  it('A (null -> member, committed) is audited as linked with A\'s state even when B changes the row before A re-reads it', async () => {
    const mass = await request(server).post('/api/calendar').set(auth(A.token)).send({ title: `Sunday Mass R4 ${RUN_ID}`, date: '2027-07-11', start_time: '10:00', end_time: '11:00', type: 'service' })
    expect(mass.status).toBe(201)
    const c = await post(A, { intention: 'For Synthetic Dario', requested_by: 'Synthetic Dario' })
    expect(c.status).toBe(201)
    const id = Number(c.body.id)
    expect(c.body.status).toBe('open'); expect(c.body.requested_by_client_id ?? null).toBeNull()

    // Barrier on A's post-COMMIT full re-read of this row (first one only).
    let reached, release
    const atBarrier = new Promise(r => { reached = r })
    const gate = new Promise(r => { release = r })
    let armed = true
    const orig = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation(async (sql, params, ...rest) => {
      if (armed && typeof sql === 'string' && sql.includes('WHERE s.id = $1 AND s.organization_id = $2') && Number(params?.[0]) === id) {
        armed = false
        // A has COMMITted: prove it from the DB before letting B in.
        reached()
        await gate
      }
      return orig(sql, params, ...rest)
    })
    try {
      const aDone = patch(id, { requested_by_client_id: memberA }).then(r => r)
      await atBarrier
      const committedA = (await orig('SELECT requested_by_client_id, status, calendar_event_id FROM ochr_mass_intentions WHERE id=$1', [id])).rows[0]
      expect({ ...committedA, requested_by_client_id: Number(committedA.requested_by_client_id) }).toEqual({ requested_by_client_id: memberA, status: 'open', calendar_event_id: null })
      const b = await patch(id, { requested_by_client_id: null, calendar_event_id: mass.body.id })
      expect(b.status).toBe(200)
      expect(b.body).toMatchObject({ status: 'scheduled' })
      release()
      const a = await aDone
      expect(a.status).toBe(200)
    } finally { release(); spy.mockRestore() }

    const rows = await updatesFor(id, 2)
    expect(rows).toHaveLength(2)
    const aRow = rows.find(m => JSON.stringify(m.changed) === JSON.stringify(['requested_by_client_id']))
    const bRow = rows.find(m => m !== aRow)
    expect(aRow).toBeDefined(); expect(bRow).toBeDefined()
    expect(aRow).toEqual({ intention_id: id, requested_by_client_id: memberA, calendar_event_id: null, status: 'open', changed: ['requested_by_client_id'], link: 'linked' })
    expect(bRow).toMatchObject({ intention_id: id, requested_by_client_id: null, calendar_event_id: Number(mass.body.id), status: 'scheduled', link: 'unlinked' })
    expect(bRow.changed).toEqual(expect.arrayContaining(['requested_by_client_id', 'status', 'calendar_event_id']))
    expect(JSON.stringify(rows)).not.toMatch(/Dario/)
  })
})

// R4-L1 (Carolina at 2cc1e73b): assign, unassign and create must also audit
// THIS request's own saved row, not a post-save re-read that a concurrent
// writer can change first. Same real-PG barrier technique as R285-4.
describe('R4-L1 assign/unassign/create audit is bound to the request\'s own saved row', () => {
  const patch = (id, body) => request(server).patch(`/api/mass-intentions/${id}`).set(auth(A.token)).send(body)
  const sub = (id, op, body = {}) => request(server).post(`/api/mass-intentions/${id}/${op}`).set(auth(A.token)).send(body)
  const massOn = async (date, tag) => {
    const m = await request(server).post('/api/calendar').set(auth(A.token)).send({ title: `Sunday Mass ${tag} ${RUN_ID}`, date, start_time: '10:00', end_time: '11:00', type: 'service' })
    expect(m.status).toBe(201)
    return Number(m.body.id)
  }
  const auditRows = async (id, n) => {
    let rows = []
    for (let i = 0; i < 80; i++) {
      rows = (await pool.query("SELECT action, metadata FROM ochr_audit_log WHERE organization_id=$1 AND entity_type='mass_intention' AND entity_id=$2 ORDER BY id", [A.id, String(id)])).rows
      if (rows.length >= n) break
      await new Promise(r => setTimeout(r, 50))
    }
    return rows
  }
  // Hold the first post-save full re-read (loadFull / create re-read) that
  // matches `pick`, run `during(id)` while it is held, then release.
  async function withBarrier(pick, start, during) {
    let reached, release
    const atBarrier = new Promise(r => { reached = r })
    const gate = new Promise(r => { release = r })
    let armed = true
    const orig = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation(async (sql, params, ...rest) => {
      if (armed && typeof sql === 'string' && sql.includes('WHERE s.id = $1 AND s.organization_id = $2') && pick(params)) {
        armed = false
        reached(Number(params[0]))
        await gate
      }
      return orig(sql, params, ...rest)
    })
    try {
      const done = start().then(r => r)
      const heldId = await atBarrier
      await during(heldId, orig)
      release()
      const r = await done
      return { r, heldId }
    } finally { release(); spy.mockRestore() }
  }

  it('assign: audit records the Mass/status this assign committed, not B\'s later unlink + release', async () => {
    const m1 = await massOn('2027-08-01', 'L1a')
    const c = await post(A, { intention: 'For Synthetic Elena', requested_by_client_id: memberA })
    expect(c.status).toBe(201)
    const id = Number(c.body.id)
    await auditRows(id, 1)
    const { r } = await withBarrier(p => Number(p?.[0]) === id, () => sub(id, 'assign', { calendar_event_id: m1 }), async (_, orig) => {
      const s = (await orig('SELECT calendar_event_id, status FROM ochr_mass_intentions WHERE id=$1', [id])).rows[0]
      expect({ calendar_event_id: Number(s.calendar_event_id), status: s.status }).toEqual({ calendar_event_id: m1, status: 'scheduled' })
      const b = await patch(id, { requested_by_client_id: null, calendar_event_id: null })
      expect(b.status).toBe(200); expect(b.body.status).toBe('open')
    })
    expect(r.status).toBe(200)
    const rows = await auditRows(id, 3)
    const assign = rows.find(x => x.metadata.op === 'assign')
    expect(assign).toBeDefined()
    expect(assign.metadata).toEqual({ intention_id: id, requested_by_client_id: memberA, calendar_event_id: m1, status: 'scheduled', op: 'assign' })
    const bRow = rows.find(x => x.action === 'update' && !('op' in x.metadata))
    expect(bRow.metadata).toMatchObject({ requested_by_client_id: null, calendar_event_id: null, status: 'open', link: 'unlinked' })
  })

  it('unassign: audit records the release this request committed, not B\'s later re-assign', async () => {
    const m1 = await massOn('2027-08-08', 'L1b')
    const m2 = await massOn('2027-08-08', 'L1c')
    const c = await post(A, { intention: 'For Synthetic Fabio', calendar_event_id: m1 })
    expect(c.status).toBe(201); expect(c.body.status).toBe('scheduled')
    const id = Number(c.body.id)
    await auditRows(id, 1)
    const { r } = await withBarrier(p => Number(p?.[0]) === id, () => sub(id, 'unassign'), async () => {
      const b = await sub(id, 'assign', { calendar_event_id: m2 })
      expect(b.status).toBe(200); expect(Number(b.body.calendar_event_id)).toBe(m2)
    })
    expect(r.status).toBe(200)
    const rows = await auditRows(id, 3)
    const un = rows.find(x => x.metadata.op === 'unassign')
    const as = rows.find(x => x.metadata.op === 'assign')
    expect(un.metadata).toEqual({ intention_id: id, requested_by_client_id: null, calendar_event_id: null, status: 'open', op: 'unassign' })
    expect(as.metadata).toEqual({ intention_id: id, requested_by_client_id: null, calendar_event_id: m2, status: 'scheduled', op: 'assign' })
  })

  it('create: audit records the row this POST inserted, not B\'s edit before the re-read', async () => {
    const before = (await pool.query('SELECT COALESCE(MAX(id),0)::int m FROM ochr_mass_intentions')).rows[0].m
    const { r, heldId } = await withBarrier(p => Number(p?.[0]) > before && Number(p?.[1]) === A.id,
      () => post(A, { intention: 'For Synthetic Gemma', requested_by_client_id: memberA }),
      async (hid) => {
        const b = await patch(hid, { requested_by_client_id: null, status: 'cancelled' })
        expect(b.status).toBe(200)
      })
    expect(r.status).toBe(201)
    const rows = await auditRows(heldId, 2)
    const create = rows.find(x => x.action === 'create')
    expect(create.metadata).toEqual({ intention_id: heldId, requested_by_client_id: memberA, calendar_event_id: null, status: 'open' })
    expect(JSON.stringify(rows)).not.toMatch(/Gemma/)
  })
})
