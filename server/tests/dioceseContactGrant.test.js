// Diocese → parish leadership contact PII follows the PARISH'S grant (#214).
//
// The Parish Care Brief lists a parish's leadership (names and roles from
// the parish's own tradition). Before this change, any diocesan user whose
// account held `pastoral_lead` also received those people's email and phone,
// whatever the parish had agreed to share. The parish-side grant
// (ochr_diocese_affiliations.grant_level: 'summary' | 'detail') is about
// FINANCIAL detail — the words a parish reads when it accepts are
// "period-level financial summaries" / "account-level lines". Neither level
// says anything about handing its clergy's phone numbers to the chancery.
//
// So: contact PII is released only when the grant explicitly includes it,
// and no grant level does today. It fails closed at the query, not just at
// the response. A diocesan `viewer` can never receive it, even if a future
// grant level includes it.
//
// Demo data only: two dioceses, three parishes, synthetic example.com people.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { grantAllows, liveAffiliationSql, liveGrantLevel, mayReceiveLeadershipContacts } from '../src/diocese/parishGrant.js'

let server
const cleanup = []
const T = {}          // tokens
const P = {}          // parish ids
const LEADERS = {}    // parish key → { name, email, phone }

const ip = n => `10.214.0.${n}`

async function login(email, password) {
  const r = await request(server).post('/api/auth/login').send({ email, password })
  expect(r.status, `login ${email}`).toBe(200)
  return r.body.token
}

async function makeDiocese(key, n) {
  const email = `dcg_${key}_${RUN_ID}@example.com`
  const res = await createOrg(server, {
    organizationName: `DCG Chancery ${key} ${RUN_ID}`, name: `Bishop ${key}`,
    email, password: `dcg-${key}-pw-1`, organizationType: 'diocese',
  }, ip(n))
  expect(res.status, `diocese ${key}`).toBeLessThan(300)
  cleanup.push(res.body.user.organization.id)
  return { token: res.body.token, orgId: res.body.user.organization.id }
}

async function makeParish(key, n) {
  const email = `dcg_p${key}_${RUN_ID}@example.com`
  const res = await createOrg(server, {
    organizationName: `DCG Parish ${key} ${RUN_ID}`, name: `Secretary ${key}`,
    email, password: `dcg-p${key}-pw-1`,
  }, ip(n))
  expect(res.status, `parish ${key}`).toBe(201)
  cleanup.push(res.body.user.organization.id)
  const leader = {
    name: `Fr Leader ${key} ${RUN_ID}`,
    email: `leader_${key}_${RUN_ID}@example.com`,
    phone: `555-02${n}${n}`,
  }
  const c = await request(server).post('/api/clients')
    .set('Authorization', `Bearer ${res.body.token}`)
    .send({ name: leader.name, role: 'Pastor', email: leader.email, phone: leader.phone })
  expect(c.status, `leader ${key}`).toBe(201)
  LEADERS[key] = { ...leader, clientId: c.body.id }
  return { token: res.body.token, orgId: res.body.user.organization.id, adminEmail: email }
}

async function affiliate(dioTok, parish, grant) {
  const inv = await request(server).post('/api/diocese/parishes/invite')
    .set('Authorization', `Bearer ${dioTok}`).send({ email: parish.adminEmail })
  expect(inv.status).toBeLessThan(300)
  if (grant) {
    const acc = await request(server).post('/api/affiliation/accept')
      .set('Authorization', `Bearer ${parish.token}`).send({ grant_level: grant })
    expect(acc.status).toBe(200)
  }
}

async function dioceseUser(dioTok, dioOrg, key, role, lead) {
  const email = `dcg_u_${key}_${RUN_ID}@example.com`
  const pw = `dcg-u-${key}-pw-1`
  const r = await request(server).post('/api/users')
    .set('Authorization', `Bearer ${dioTok}`)
    .send({ name: `User ${key}`, email, password: pw, role: role === 'viewer' ? 'staff' : role })
  expect(r.status, `user ${key}`).toBe(201)
  // Role and pastoral_lead set directly so the test pins the exact shape
  // under test regardless of which roles the users route lets an admin mint.
  await pool.query(
    'UPDATE ochr_users SET role = $1, pastoral_lead = $2 WHERE lower(email) = $3 AND organization_id = $4',
    [role, lead, email, dioOrg])
  return login(email, pw)
}

const brief = (tok, parishId) => request(server)
  .get(`/api/diocese/care/${parishId}/brief`).set('Authorization', `Bearer ${tok}`)

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const d1 = await makeDiocese('d1', 1)
  const d2 = await makeDiocese('d2', 2)
  T.d1Admin = d1.token

  const pSummary = await makeParish('sum', 3)
  const pDetail  = await makeParish('det', 4)
  const pOther   = await makeParish('oth', 5)
  const pInvited = await makeParish('inv', 6)
  const pSusp    = await makeParish('sus', 7)
  const pGone    = await makeParish('gone', 8)
  P.summary = pSummary.orgId; P.detail = pDetail.orgId
  P.other = pOther.orgId;     P.invited = pInvited.orgId
  P.suspended = pSusp.orgId;  P.gone = pGone.orgId
  T.parishSummary = pSummary.token
  T.parishDetail = pDetail.token
  T.parishSuspended = pSusp.token
  T.parishGone = pGone.token

  await affiliate(d1.token, pSummary, 'summary')
  await affiliate(d1.token, pDetail, 'detail')
  await affiliate(d2.token, pOther, 'detail')
  await affiliate(d1.token, pInvited, null)      // invited, never accepted
  await affiliate(d1.token, pSusp, 'detail')      // accepted, then suspended below
  await affiliate(d1.token, pGone, 'summary')     // left, in the follow-up tests
  const { rows: sa } = await pool.query(
    `SELECT id FROM ochr_diocese_affiliations WHERE parish_org_id = $1 AND status = 'active'`, [P.suspended])
  const sus = await request(server).patch(`/api/diocese/parishes/${sa[0].id}`)
    .set('Authorization', `Bearer ${d1.token}`).send({ status: 'suspended' })
  expect(sus.status).toBe(200)
  expect(sus.body.status).toBe('suspended')

  T.d2Admin = d2.token
  T.lead    = await dioceseUser(d1.token, d1.orgId, 'lead', 'staff', true)
  T.staff   = await dioceseUser(d1.token, d1.orgId, 'staff', 'staff', false)
  T.viewer  = await dioceseUser(d1.token, d1.orgId, 'view', 'viewer', false)
  T.viewerLead = await dioceseUser(d1.token, d1.orgId, 'vlead', 'viewer', true)
}, 120_000)

afterAll(async () => {
  for (const id of cleanup) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
})

const leaksContact = (body, key) => {
  const s = JSON.stringify(body)
  return s.includes(LEADERS[key].email) || s.includes(LEADERS[key].phone)
}

describe('capability map (unit)', () => {
  it('no grant level releases leadership contacts today', () => {
    for (const g of ['summary', 'detail']) {
      expect(grantAllows(g, 'leadership.contacts'), g).toBe(false)
      expect(grantAllows(g, 'leadership.roster'), g).toBe(true)
    }
  })

  it('an unknown or ended grant releases nothing', () => {
    for (const g of [null, undefined, '', 'full', 'DETAIL', 42, {}]) {
      expect(grantAllows(g, 'leadership.roster')).toBe(false)
      expect(grantAllows(g, 'leadership.contacts')).toBe(false)
    }
  })

  it('a viewer never receives contacts, even under a grant that would allow them', () => {
    const allowAll = () => true
    expect(mayReceiveLeadershipContacts({ role: 'viewer', pastoral_lead: true }, 'detail', allowAll)).toBe(false)
    expect(mayReceiveLeadershipContacts({ role: 'staff', pastoral_lead: false }, 'detail', allowAll)).toBe(false)
    expect(mayReceiveLeadershipContacts({ role: 'staff', pastoral_lead: true }, 'detail', allowAll)).toBe(true)
    expect(mayReceiveLeadershipContacts({ role: 'staff', pastoral_lead: true }, 'detail')).toBe(false)
  })
})

describe('only an ACTIVE affiliation carries a grant (unit)', () => {
  it('suspended, invited, ended and unknown affiliations have no live grant', () => {
    for (const status of ['suspended', 'invited', 'ended', undefined, 'ACTIVE']) {
      expect(liveGrantLevel({ status, grant_level: 'detail' }), String(status)).toBeNull()
    }
    expect(liveGrantLevel({ status: 'active', grant_level: 'detail' })).toBe('detail')
    expect(liveGrantLevel({ status: 'active', grant_level: 'summary' })).toBe('summary')
    expect(liveGrantLevel({ status: 'active', grant_level: 'full' })).toBeNull()
    expect(liveGrantLevel(null)).toBeNull()
  })

  it('the SQL fragment names the same live rule, and nothing suspended', () => {
    const sql = liveAffiliationSql('a')
    expect(sql).toBe("a.status IN ('active') AND a.grant_level IN ('summary', 'detail')")
    expect(sql).not.toMatch(/suspended|invited|ended/)
    expect(() => liveAffiliationSql('a; drop')).toThrow(/identifier/)
  })
})

describe('a SUSPENDED affiliation releases nothing', () => {
  it('no leadership roster (404, nothing about the parish in the body)', async () => {
    for (const tok of [T.staff, T.lead, T.d1Admin]) {
      const r = await brief(tok, P.suspended)
      expect(r.status).toBe(404)
      expect(JSON.stringify(r.body)).not.toContain(LEADERS.sus.name)
    }
  })

  it('a pastoral lead gets no email or phone for a suspended parish', async () => {
    const r = await brief(T.lead, P.suspended)
    expect(r.status).toBe(404)
    expect(leaksContact(r.body, 'sus')).toBe(false)
  })

  it('reinstating to active restores exactly the grant-allowed roster, still no contacts', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM ochr_diocese_affiliations WHERE parish_org_id = $1 AND status = 'suspended'`, [P.suspended])
    const up = await request(server).patch(`/api/diocese/parishes/${rows[0].id}`)
      .set('Authorization', `Bearer ${T.d1Admin}`).send({ status: 'active' })
    expect(up.status).toBe(200)
    try {
      const r = await brief(T.lead, P.suspended)
      expect(r.status).toBe(200)
      expect(r.body.people.map(p => p.name)).toContain(LEADERS.sus.name)
      expect(leaksContact(r.body, 'sus')).toBe(false)
    } finally {
      await request(server).patch(`/api/diocese/parishes/${rows[0].id}`)
        .set('Authorization', `Bearer ${T.d1Admin}`).send({ status: 'suspended' })
    }
  })
})

describe('Care Brief leadership contact PII follows the parish grant', () => {
  it('pastoral lead under a SUMMARY grant gets names and roles but no email or phone', async () => {
    const r = await brief(T.lead, P.summary)
    expect(r.status).toBe(200)
    const leader = r.body.people.find(p => p.name === LEADERS.sum.name)
    expect(leader, 'the parish leader is still named').toBeTruthy()
    expect(leader.role).toBe('Pastor')
    expect(leader).not.toHaveProperty('email')
    expect(leader).not.toHaveProperty('phone')
    expect(leaksContact(r.body, 'sum')).toBe(false)
    expect(r.body.withheld).toMatch(/contact details/i)
  })

  it('pastoral lead under a DETAIL grant still gets no contact PII — financial detail is not contact consent', async () => {
    const r = await brief(T.lead, P.detail)
    expect(r.status).toBe(200)
    expect(r.body.people.some(p => p.name === LEADERS.det.name)).toBe(true)
    expect(leaksContact(r.body, 'det')).toBe(false)
  })

  it('the founding chancery admin (pastoral lead) gets no contact PII either', async () => {
    const r = await brief(T.d1Admin, P.detail)
    expect(r.status).toBe(200)
    expect(leaksContact(r.body, 'det')).toBe(false)
  })

  it('a view-only diocesan user holding pastoral_lead gets no contact PII under any grant', async () => {
    for (const [pid, key] of [[P.summary, 'sum'], [P.detail, 'det']]) {
      const r = await brief(T.viewerLead, pid)
      expect(r.status).toBe(200)
      expect(leaksContact(r.body, key)).toBe(false)
    }
  })

  it('active DETAIL: names/roles plus per-account financial lines, and still no contact PII', async () => {
    const sub = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${T.parishDetail}`)
      .send({ period_start: '2031-02-01', period_end: '2031-02-28' })
    expect(sub.status).toBe(201)
    const rev = await request(server).get(`/api/diocese/care/submissions/${sub.body.id}/review`)
      .set('Authorization', `Bearer ${T.lead}`)
    expect(rev.status).toBe(200)
    expect(rev.body.grant_level).toBe('detail')
    expect(rev.body.submission.totals_json).toHaveProperty('accounts')
    const b = await brief(T.lead, P.detail)
    expect(b.body.people.find(p => p.name === LEADERS.det.name)?.role).toBe('Pastor')
    expect(leaksContact(b.body, 'det')).toBe(false)
    expect(leaksContact(rev.body, 'det')).toBe(false)
  })

  it('authorized access still works: a live grant releases the leadership roster', async () => {
    for (const [tok, pid, key] of [[T.lead, P.summary, 'sum'], [T.staff, P.detail, 'det']]) {
      const r = await brief(tok, pid)
      expect(r.status).toBe(200)
      expect(r.body.people.map(p => p.name)).toContain(LEADERS[key].name)
      expect(r.body.parish.name).toMatch(/DCG Parish/)
    }
  })
})

describe('no cross-parish bleed, and affiliation alone is not a grant', () => {
  it('each brief names only its own parish leadership', async () => {
    const r = await brief(T.lead, P.summary)
    const names = r.body.people.map(p => p.name)
    expect(names).toContain(LEADERS.sum.name)
    for (const k of ['det', 'oth', 'inv']) expect(names).not.toContain(LEADERS[k].name)
  })

  it('a parish affiliated with ANOTHER diocese is invisible (404), and leaks nothing', async () => {
    const r = await brief(T.lead, P.other)
    expect(r.status).toBe(404)
    expect(JSON.stringify(r.body)).not.toContain(LEADERS.oth.name)
  })

  it('the other diocese sees its own parish only', async () => {
    const own = await brief(T.d2Admin, P.other)
    expect(own.status).toBe(200)
    expect(own.body.people.map(p => p.name)).toContain(LEADERS.oth.name)
    expect(leaksContact(own.body, 'oth')).toBe(false)
    const foreign = await brief(T.d2Admin, P.summary)
    expect(foreign.status).toBe(404)
  })

  it('an invitation the parish never accepted grants nothing (404)', async () => {
    const r = await brief(T.lead, P.invited)
    expect(r.status).toBe(404)
    expect(JSON.stringify(r.body)).not.toContain(LEADERS.inv.name)
  })
})

describe('parish-side access is unaffected', () => {
  it('the parish still reads its own leader\'s email and phone', async () => {
    const r = await request(server).get(`/api/clients/${LEADERS.sum.clientId}`)
      .set('Authorization', `Bearer ${T.parishSummary}`)
    expect(r.status).toBe(200)
    const c = r.body.client ?? r.body
    expect(c.email).toBe(LEADERS.sum.email)
    expect(c.phone).toBe(LEADERS.sum.phone)
  })
})

describe('an active grant still opens care, and still withholds contacts', () => {
  it('GET detail returns parish context and no leadership email or phone', async () => {
    const r = await request(server).get(`/api/diocese/care/${P.summary}`)
      .set('Authorization', `Bearer ${T.lead}`)
    expect(r.status).toBe(200)
    expect(r.body.parish.name).toMatch(/DCG Parish sum/)
    expect(r.body.parish.affiliation_status).toBe('active')
    expect(r.body.parish.grant_level).toBe('summary')
    expect(leaksContact(r.body, 'sum')).toBe(false)

    const list = await request(server).get('/api/diocese/care')
      .set('Authorization', `Bearer ${T.staff}`)
    expect(list.status).toBe(200)
    expect(list.body.parishes.some(p => p.parish_org_id === P.summary)).toBe(true)
    expect(list.body.parishes.some(p => p.parish_org_id === P.invited)).toBe(false)
  })

  it('an invitation the parish never accepted releases no parish context', async () => {
    const r = await request(server).get(`/api/diocese/care/${P.invited}`)
      .set('Authorization', `Bearer ${T.lead}`)
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Not found' })
    expect(JSON.stringify(r.body)).not.toContain(LEADERS.inv.name)
  })
})

describe('brief internal notes are for a pastoral lead only', () => {
  const NOTE = `DCG-INTERNAL-${RUN_ID} office confidence`

  beforeAll(async () => {
    const t = await request(server).post(`/api/diocese/care/${P.summary}/timeline`)
      .set('Authorization', `Bearer ${T.lead}`)
      .send({ kind: 'note', summary: NOTE, visibility: 'diocese' })
    expect(t.status).toBe(201)
  })

  it('a pastoral lead sees the note only with ?internal=1', async () => {
    const off = await brief(T.lead, P.summary)
    expect(off.status).toBe(200)
    expect(off.body.internal_included).toBe(false)
    expect(JSON.stringify(off.body)).not.toContain(NOTE)

    const on = await request(server).get(`/api/diocese/care/${P.summary}/brief?internal=1`)
      .set('Authorization', `Bearer ${T.lead}`)
    expect(on.status).toBe(200)
    expect(on.body.internal_included).toBe(true)
    expect(JSON.stringify(on.body)).toContain(NOTE)
    expect(leaksContact(on.body, 'sum')).toBe(false)
  })

  it('a non-lead staff member gets no internal content, with or without ?internal=1', async () => {
    for (const qs of ['', '?internal=1']) {
      const r = await request(server).get(`/api/diocese/care/${P.summary}/brief${qs}`)
        .set('Authorization', `Bearer ${T.staff}`)
      expect(r.status, qs || 'default').toBe(200)
      expect(r.body.internal_included).toBe(false)
      expect(JSON.stringify(r.body)).not.toContain(NOTE)
    }
  })

  it('a viewer who is not a pastoral lead gets no internal content, with or without ?internal=1', async () => {
    for (const qs of ['', '?internal=1']) {
      const r = await request(server).get(`/api/diocese/care/${P.summary}/brief${qs}`)
        .set('Authorization', `Bearer ${T.viewer}`)
      expect(r.status, qs || 'default').toBe(200)
      expect(r.body.internal_included).toBe(false)
      expect(JSON.stringify(r.body)).not.toContain(NOTE)
    }
  })
})

describe('a suspended affiliation releases no care data', () => {
  const ADDR = `DCG-ADDR-${RUN_ID}`
  const TIMES = `DCG-TIMES-${RUN_ID}`
  const FU = `DCG-FU-${RUN_ID} context for the office`
  const TR = `DCG-TR-${RUN_ID} continuity note`
  const TL = `DCG-TL-${RUN_ID} shared timeline sentence`
  const SHARED_NOTE = `DCG-REV-SHARED-${RUN_ID} walked the period together`
  const INTERNAL_NOTE = `DCG-REV-INTERNAL-${RUN_ID} office only`
  const LINKED_FU = `DCG-REV-FU-${RUN_ID} linked follow-up context`
  let followupId, transitionId, submissionId, affId

  beforeAll(async () => {
    const { rows } = await pool.query(
      `SELECT id FROM ochr_diocese_affiliations
        WHERE parish_org_id = $1 AND status = 'suspended'`, [P.suspended])
    expect(rows.length).toBe(1)
    affId = rows[0].id
    const up = await request(server).patch(`/api/diocese/parishes/${affId}`)
      .set('Authorization', `Bearer ${T.d1Admin}`).send({ status: 'active' })
    expect(up.status).toBe(200)

    await pool.query(
      `UPDATE ochr_organizations SET address = $1, service_times = $2 WHERE id = $3`,
      [ADDR, TIMES, P.suspended])

    const fu = await request(server).post(`/api/diocese/care/${P.suspended}/followups`)
      .set('Authorization', `Bearer ${T.d1Admin}`)
      .send({ context: FU, next_action: `Call the office ${RUN_ID}` })
    expect(fu.status).toBe(201)
    followupId = fu.body.id

    const tr = await request(server).post(`/api/diocese/care/${P.suspended}/transitions`)
      .set('Authorization', `Bearer ${T.d1Admin}`)
      .send({
        kind: 'clergy_arrival', notes: TR,
        continuity_needs: `DCG-CN-${RUN_ID}`, support_plan: `DCG-SP-${RUN_ID}`,
      })
    expect(tr.status).toBe(201)
    transitionId = tr.body.id

    const tl = await request(server).post(`/api/diocese/care/${P.suspended}/timeline`)
      .set('Authorization', `Bearer ${T.d1Admin}`)
      .send({ kind: 'note', summary: TL, visibility: 'shared' })
    expect(tl.status).toBe(201)

    const sub = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${T.parishSuspended}`)
      .send({ period_start: '2032-01-01', period_end: '2032-01-31' })
    expect(sub.status).toBe(201)
    submissionId = sub.body.id

    const shared = await request(server)
      .post(`/api/diocese/care/submissions/${submissionId}/notes`)
      .set('Authorization', `Bearer ${T.lead}`)
      .send({ body: SHARED_NOTE, visibility: 'shared' })
    expect(shared.status).toBe(201)
    const internal = await request(server)
      .post(`/api/diocese/care/submissions/${submissionId}/notes`)
      .set('Authorization', `Bearer ${T.lead}`)
      .send({ body: INTERNAL_NOTE, visibility: 'diocese' })
    expect(internal.status).toBe(201)
    const linked = await request(server)
      .post(`/api/diocese/care/${P.suspended}/followups`)
      .set('Authorization', `Bearer ${T.lead}`)
      .send({
        context: LINKED_FU,
        next_action: `Linked next step ${RUN_ID}`,
        from_submission_id: submissionId,
      })
    expect(linked.status).toBe(201)

    const activeLead = await request(server)
      .get(`/api/diocese/care/submissions/${submissionId}/review`)
      .set('Authorization', `Bearer ${T.lead}`)
    expect(activeLead.status).toBe(200)
    expect(JSON.stringify(activeLead.body.notes)).toContain(SHARED_NOTE)
    expect(JSON.stringify(activeLead.body.notes)).toContain(INTERNAL_NOTE)
    expect(JSON.stringify(activeLead.body.followups)).toContain(LINKED_FU)
    expect(activeLead.body.may_see_internal).toBe(true)
    expect(activeLead.body.submission.totals_json).toHaveProperty('accounts')

    const activeStaff = await request(server)
      .get(`/api/diocese/care/submissions/${submissionId}/review`)
      .set('Authorization', `Bearer ${T.staff}`)
    expect(activeStaff.status).toBe(200)
    expect(JSON.stringify(activeStaff.body.notes)).toContain(SHARED_NOTE)
    expect(JSON.stringify(activeStaff.body.notes)).not.toContain(INTERNAL_NOTE)
    expect(JSON.stringify(activeStaff.body.followups)).toContain(LINKED_FU)
    expect(activeStaff.body.submission.totals_json).toHaveProperty('accounts')

    const live = await request(server).get(`/api/diocese/care/${P.suspended}`)
      .set('Authorization', `Bearer ${T.lead}`)
    expect(live.status).toBe(200)
    const liveBody = JSON.stringify(live.body)
    expect(liveBody).toContain(ADDR)
    expect(liveBody).toContain(TIMES)
    expect(liveBody).toContain(FU)
    expect(liveBody).toContain(TR)
    expect(liveBody).toContain(TL)
    expect(leaksContact(live.body, 'sus')).toBe(false)

    const sus = await request(server).patch(`/api/diocese/parishes/${affId}`)
      .set('Authorization', `Bearer ${T.d1Admin}`).send({ status: 'suspended' })
    expect(sus.status).toBe(200)
    expect(sus.body.status).toBe('suspended')
  }, 30_000)

  afterAll(async () => {
    if (!affId) return
    await request(server).patch(`/api/diocese/parishes/${affId}`)
      .set('Authorization', `Bearer ${T.d1Admin}`).send({ status: 'suspended' })
  })

  const absent = (body) => {
    const s = JSON.stringify(body)
    for (const marker of [ADDR, TIMES, FU, TR, TL, LEADERS.sus.name, LEADERS.sus.email, LEADERS.sus.phone]) {
      expect(s, marker).not.toContain(marker)
    }
  }

  it('GET detail is 404 and carries none of the parish context', async () => {
    for (const tok of [T.lead, T.staff, T.viewer]) {
      const r = await request(server).get(`/api/diocese/care/${P.suspended}`)
        .set('Authorization', `Bearer ${tok}`)
      expect(r.status).toBe(404)
      expect(r.body).toEqual({ error: 'Not found' })
      absent(r.body)
    }
  })

  it('the dashboard list omits the parish', async () => {
    const r = await request(server).get('/api/diocese/care')
      .set('Authorization', `Bearer ${T.lead}`)
    expect(r.status).toBe(200)
    expect(r.body.parishes.some(p => p.parish_org_id === P.suspended)).toBe(false)
    expect(JSON.stringify(r.body)).not.toContain(ADDR)
  })

  it('follow-ups are not listed, and PATCH does not write or return the row', async () => {
    const list = await request(server).get('/api/diocese/care/followups')
      .set('Authorization', `Bearer ${T.lead}`)
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.body)).not.toContain(FU)

    const patch = await request(server).patch(`/api/diocese/care/followups/${followupId}`)
      .set('Authorization', `Bearer ${T.lead}`)
      .send({ state: 'done', completion_note: 'should not land' })
    expect(patch.status).toBe(404)
    expect(patch.body).toEqual({ error: 'Not found' })
    absent(patch.body)

    const { rows } = await pool.query(
      `SELECT state FROM ochr_parish_followups WHERE id = $1`, [followupId])
    expect(rows[0].state).toBe('open')
  })

  it('PATCH transition fails closed and does not return the row', async () => {
    const patch = await request(server).patch(`/api/diocese/care/transitions/${transitionId}`)
      .set('Authorization', `Bearer ${T.lead}`)
      .send({ state: 'settled', support_plan: 'should not land' })
    expect(patch.status).toBe(404)
    expect(patch.body).toEqual({ error: 'Not found' })
    absent(patch.body)
    const { rows } = await pool.query(
      `SELECT state, notes FROM ochr_parish_transitions WHERE id = $1`, [transitionId])
    expect(rows[0].state).toBe('watching')
    expect(rows[0].notes).toBe(TR)
  })

  it('POST routes gated by the live affiliation are 404 and write nothing', async () => {
    const posts = [
      [`/api/diocese/care/${P.suspended}/timeline`, { kind: 'note', summary: `DCG-POST-TL-${RUN_ID} no` }],
      [`/api/diocese/care/${P.suspended}/followups`, { context: `DCG-POST-FU-${RUN_ID} xx`, next_action: 'Do not save this' }],
      [`/api/diocese/care/${P.suspended}/transitions`, { kind: 'search_period', notes: `DCG-POST-TR-${RUN_ID}` }],
      [`/api/diocese/care/${P.suspended}/brief`, { purpose: `DCG-POST-BR-${RUN_ID}` }],
    ]
    for (const [path, body] of posts) {
      const r = await request(server).post(path)
        .set('Authorization', `Bearer ${T.d1Admin}`).send(body)
      expect(r.status, path).toBe(404)
      expect(r.body).toEqual({ error: 'Not found' })
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_parish_timeline WHERE summary LIKE $1`,
      [`DCG-POST-TL-${RUN_ID}%`])
    expect(rows[0].n).toBe(0)
    const { rows: fu } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_parish_followups WHERE context LIKE $1`,
      [`DCG-POST-FU-${RUN_ID}%`])
    expect(fu[0].n).toBe(0)
    const { rows: tr } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_parish_transitions WHERE notes LIKE $1`,
      [`DCG-POST-TR-${RUN_ID}%`])
    expect(tr[0].n).toBe(0)
    const { rows: briefs } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_parish_care_briefs WHERE purpose LIKE $1`,
      [`DCG-POST-BR-${RUN_ID}%`])
    expect(briefs[0].n).toBe(0)
  })

  it('mark-reviewed and review notes fail closed', async () => {
    const reviewed = await request(server)
      .post(`/api/diocese/care/submissions/${submissionId}/reviewed`)
      .set('Authorization', `Bearer ${T.d1Admin}`).send({})
    expect(reviewed.status).toBe(404)
    expect(reviewed.body).toEqual({ error: 'Not found' })

    const note = await request(server)
      .post(`/api/diocese/care/submissions/${submissionId}/notes`)
      .set('Authorization', `Bearer ${T.d1Admin}`)
      .send({ body: `DCG-NOTE-${RUN_ID} should not land`, visibility: 'shared' })
    expect(note.status).toBe(404)
    expect(note.body).toEqual({ error: 'Not found' })

    const { rows } = await pool.query(
      `SELECT reviewed_together_at FROM ochr_report_submissions WHERE id = $1`, [submissionId])
    expect(rows[0].reviewed_together_at).toBeNull()
    const { rows: notes } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_report_review_notes WHERE body LIKE $1`,
      [`DCG-NOTE-${RUN_ID}%`])
    expect(notes[0].n).toBe(0)
  })

  it('GET review while suspended returns account lines only: no notes and no follow-ups', async () => {
    for (const tok of [T.lead, T.staff]) {
      const rev = await request(server).get(`/api/diocese/care/submissions/${submissionId}/review`)
        .set('Authorization', `Bearer ${tok}`)
      expect(rev.status).toBe(200)
      expect(rev.body.grant_level).toBe('detail')
      expect(rev.body.submission.totals_json).toHaveProperty('accounts')
      expect(rev.body.notes).toEqual([])
      expect(rev.body.followups).toEqual([])
      expect(rev.body.may_see_internal).toBe(false)
      const body = JSON.stringify(rev.body)
      expect(body).not.toContain(SHARED_NOTE)
      expect(body).not.toContain(INTERNAL_NOTE)
      expect(body).not.toContain(LINKED_FU)
      expect(leaksContact(rev.body, 'sus')).toBe(false)
    }
  })
})

describe('after the parish leaves, follow-ups and patches fail closed', () => {
  const FU = `DCG-LEFT-FU-${RUN_ID} context that must vanish`
  const TR = `DCG-LEFT-TR-${RUN_ID} transition that must vanish`
  let followupId, transitionId

  beforeAll(async () => {
    const fu = await request(server).post(`/api/diocese/care/${P.gone}/followups`)
      .set('Authorization', `Bearer ${T.d1Admin}`)
      .send({ context: FU, next_action: `Next step ${RUN_ID} for the departed parish` })
    expect(fu.status).toBe(201)
    followupId = fu.body.id

    const tr = await request(server).post(`/api/diocese/care/${P.gone}/transitions`)
      .set('Authorization', `Bearer ${T.d1Admin}`)
      .send({ kind: 'records_handoff', notes: TR })
    expect(tr.status).toBe(201)
    transitionId = tr.body.id

    const listed = await request(server).get('/api/diocese/care/followups')
      .set('Authorization', `Bearer ${T.lead}`)
    expect(listed.status).toBe(200)
    expect(JSON.stringify(listed.body)).toContain(FU)

    const left = await request(server).post('/api/affiliation/leave')
      .set('Authorization', `Bearer ${T.parishGone}`)
    expect(left.status).toBe(200)
  })

  async function hiddenAndUnpatched() {
    for (const state of ['open', 'done', 'let_go']) {
      const list = await request(server).get(`/api/diocese/care/followups?state=${state}`)
        .set('Authorization', `Bearer ${T.lead}`)
      expect(list.status).toBe(200)
      expect(JSON.stringify(list.body), state).not.toContain(FU)
    }
    const fp = await request(server).patch(`/api/diocese/care/followups/${followupId}`)
      .set('Authorization', `Bearer ${T.lead}`)
      .send({ state: 'done', completion_note: 'must not land' })
    expect(fp.status).toBe(404)
    expect(fp.body).toEqual({ error: 'Not found' })
    expect(JSON.stringify(fp.body)).not.toContain(FU)

    const tp = await request(server).patch(`/api/diocese/care/transitions/${transitionId}`)
      .set('Authorization', `Bearer ${T.lead}`)
      .send({ state: 'settled', support_plan: 'must not land' })
    expect(tp.status).toBe(404)
    expect(tp.body).toEqual({ error: 'Not found' })
    expect(JSON.stringify(tp.body)).not.toContain(TR)

    const { rows: f } = await pool.query(
      `SELECT state FROM ochr_parish_followups WHERE id = $1`, [followupId])
    expect(f[0].state).toBe('open')
    const { rows: t } = await pool.query(
      `SELECT state, notes FROM ochr_parish_transitions WHERE id = $1`, [transitionId])
    expect(t[0].state).toBe('watching')
    expect(t[0].notes).toBe(TR)
  }

  it('an ended affiliation hides the follow-up and refuses both patches', async () => {
    await hiddenAndUnpatched()
    const detail = await request(server).get(`/api/diocese/care/${P.gone}`)
      .set('Authorization', `Bearer ${T.lead}`)
    expect(detail.status).toBe(404)
    expect(detail.body).toEqual({ error: 'Not found' })
    expect(JSON.stringify(detail.body)).not.toContain(FU)
  })

  it('a missing affiliation row still hides them and refuses both patches', async () => {
    const del = await pool.query(
      `DELETE FROM ochr_diocese_affiliations WHERE parish_org_id = $1 RETURNING id`, [P.gone])
    expect(del.rowCount).toBeGreaterThan(0)
    await hiddenAndUnpatched()
  })
})
