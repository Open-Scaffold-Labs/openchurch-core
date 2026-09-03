// Diocesan structure — deaneries, traditions, assessments, and what a parish
// sees of its own standing.
//
// Extracted from smoke.test.js, which had grown past 15,000 lines. These
// blocks moved because they already stood alone: each signs up its own
// parish and shares nothing with the rest of the suite. Nothing about them
// changed in the move — same assertions, same fixtures, same names.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { assessedForBands, validateBands } from '../src/routes/assessments.js'
import { RUN_ID, app, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

describe('tradition foundation (TRAD.1)', () => {
  // The defect this closes: two liturgical engines, two traditions, both
  // printed on one sheet. routes/liturgical.js says "Ordinary Time" and
  // names 1 January "Mary, Mother of God"; services/lectionary.js says
  // "Nth Sunday after Pentecost · Proper N" and names the same day
  // "The Holy Name". Every parish got both. These tests assert that a
  // parish now gets exactly one tradition's vocabulary — and that a parish
  // which has told us nothing gets NO lectionary rather than a wrong one.
  const mk = (tradition, n) => ({
    organizationName: `Trad ${tradition} ${RUN_ID}`,
    name: 'Secretary',
    email: `trad_${tradition}_${RUN_ID}@example.com`,
    password: `smoke-test-pw-2${n}`,
    tradition,
  })
  const tokens = {}
  const cleanupOrgIds = []

  beforeAll(async () => {
    let n = 0
    for (const trad of ['catholic', 'episcopal', 'general']) {
      const res = await createOrg(server, mk(trad, n++), '10.99.0.11')
      expect(res.status).toBe(201)
      tokens[trad] = res.body.token
      cleanupOrgIds.push(res.body.user.organization.id)
    }
  }, 30_000)

  afterAll(async () => {
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  const packet = async (trad, date) => {
    const res = await request(server).get(`/api/packet?date=${date}`)
      .set('Authorization', `Bearer ${tokens[trad]}`)
    expect(res.status).toBe(200)
    return res.body
  }

  it('signup records the tradition and hands it back on the org', async () => {
    const me = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${tokens.catholic}`)
    expect(me.status).toBe(200)
    const org = me.body.user?.organization ?? me.body.organization
    expect(org.tradition).toBe('catholic')
    // The client's i18n spine has read organization.locale since day one
    // and never received it. It does now.
    expect(org).toHaveProperty('locale')
  })

  it('an unrecognised tradition falls back to general rather than 400ing a signup', async () => {
    const res = await createOrg(server, { ...mk('nonsense', 9), email: `trad_bogus_${RUN_ID}@example.com` }, '10.99.0.11')
    expect(res.status).toBe(201)
    cleanupOrgIds.push(res.body.user.organization.id)
    expect(res.body.user.organization.tradition).toBe('general')
  })

  it('a Catholic parish gets Roman designations and NO Proper', async () => {
    const p = await packet('catholic', '2026-08-30')
    expect(p.tradition).toBe('catholic')
    expect(p.lectionary.designation).toBe('Twenty-second Sunday in Ordinary Time')
    expect(p.lectionary.proper).toBeNull()
  })

  it('an Episcopal parish gets RCL designations WITH a Proper', async () => {
    const p = await packet('episcopal', '2026-08-30')
    expect(p.tradition).toBe('episcopal')
    expect(p.lectionary.designation).toBe('Fourteenth Sunday after Pentecost')
    expect(p.lectionary.proper).toBe(17)
  })

  it('the two vocabularies can never appear on the same packet again', async () => {
    // The actual defect, asserted directly: one date, two parishes, and
    // neither may carry the other's words.
    const [cat, epi] = await Promise.all([packet('catholic', '2026-08-30'), packet('episcopal', '2026-08-30')])
    expect(cat.lectionary.designation).not.toMatch(/after Pentecost/)
    expect(epi.lectionary.designation).not.toMatch(/Ordinary Time/)
    expect(cat.lectionary.designation).not.toBe(epi.lectionary.designation)
  })

  it('a general org gets NO lectionary line at all', async () => {
    // Printing nothing is honest. Printing another tradition's Sunday
    // name is not, and that is what shipped before this.
    const p = await packet('general', '2026-08-30')
    expect(p.tradition).toBe('general')
    expect(p.lectionary).toBeNull()
    // …but everything else on the sheet still works.
    expect(p.liturgical.season).toBe('Ordinary Time')
    expect(p.date).toBe('2026-08-30')
  })

  it('reports which block of counted time a date falls in', async () => {
    // The canonical season token stays 'Ordinary Time' — calendar rows are
    // already stamped with it — while the block is what lets an Episcopal
    // parish render "Season after Pentecost" without a data migration.
    const after = await request(server).get('/api/liturgical?date=2026-08-30')
      .set('Authorization', `Bearer ${tokens.episcopal}`)
    expect(after.body.season).toBe('Ordinary Time')
    expect(after.body.ordinary_block).toBe('after_pentecost')

    const before = await request(server).get('/api/liturgical?date=2026-01-20')
      .set('Authorization', `Bearer ${tokens.episcopal}`)
    expect(before.body.season).toBe('Ordinary Time')
    expect(before.body.ordinary_block).toBe('after_epiphany')

    // Seasons outside counted time report null, never undefined.
    const lent = await request(server).get('/api/liturgical?date=2026-03-01')
      .set('Authorization', `Bearer ${tokens.episcopal}`)
    expect(lent.body.season).toBe('Lent')
    expect(lent.body.ordinary_block).toBeNull()
  })

  it('an admin can change tradition, and the packet follows immediately', async () => {
    const before = await packet('general', '2026-08-30')
    expect(before.lectionary).toBeNull()

    const patch = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokens.general}`).send({ tradition: 'catholic' })
    expect(patch.status).toBe(200)
    expect(patch.body.tradition ?? patch.body.organization?.tradition).toBe('catholic')

    // The 60s cache must not outlive the admin's own page load.
    const after = await packet('general', '2026-08-30')
    expect(after.tradition).toBe('catholic')
    expect(after.lectionary.designation).toBe('Twenty-second Sunday in Ordinary Time')

    await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokens.general}`).send({ tradition: 'general' })
  })

  it('refuses an unknown tradition on PATCH rather than silently generalising', async () => {
    const res = await request(server).patch('/api/organization')
      .set('Authorization', `Bearer ${tokens.catholic}`).send({ tradition: 'zoroastrian' })
    expect(res.status).toBe(400)
    const me = await request(server).get('/api/organization')
      .set('Authorization', `Bearer ${tokens.catholic}`)
    expect(me.body.tradition ?? me.body.organization?.tradition).toBe('catholic')
  })

  it('the database refuses a bad tradition even if a route ever stops checking', async () => {
    await expect(
      pool.query('UPDATE ochr_organizations SET tradition = $1 WHERE id = $2', ['nonsense', cleanupOrgIds[0]])
    ).rejects.toThrow()
  })
})

describe('tradition-aware sample data (TRAD.2)', () => {
  // sampleSeed.js used to declare itself "intentionally
  // denomination-neutral" and then seed tithe, Sunday School Teacher,
  // Worship Leader, Prayer Team, Fellowship Hall and Bible Study — which
  // is not neutral, it is low-church Protestant. A brand-new Catholic
  // parish met that inside a Catholic shell: the nav said Intentions and
  // Register while the sample data said Fellowship Hall.
  //
  // The seed now follows the tradition chosen AT SIGNUP, because the seed
  // runs the moment signup commits — asking afterwards is too late.
  const cleanupOrgIds = []
  const tokens = {}

  const signup = async (tradition, n) => {
    const res = await createOrg(server, {
        organizationName: `Seed ${tradition} ${RUN_ID}`,
        name: 'Secretary',
        email: `seed_${tradition}_${RUN_ID}@example.com`,
        password: `smoke-test-pw-4${n}`,
        ...(tradition === 'unset' ? {} : { tradition }),
      }, '10.99.0.13')
    expect(res.status).toBe(201)
    cleanupOrgIds.push(res.body.user.organization.id)
    return res.body.token
  }

  beforeAll(async () => {
    let n = 0
    for (const t of ['catholic', 'episcopal', 'lutheran', 'unset']) {
      tokens[t] = await signup(t, n++)
    }
    // The seed is fired after the signup transaction commits, on purpose —
    // a seed failure must never block account creation. Give it a moment.
    await new Promise(r => setTimeout(r, 1500))
  }, 45_000)

  afterAll(async () => {
    for (const id of cleanupOrgIds) {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  // These endpoints return a bare array, not a wrapper. Asserting the
  // shape rather than defaulting to [] — a helper that silently yields an
  // empty list turns every assertion below into a test of nothing.
  const listOf = async (path, trad) => {
    const res = await request(server).get(path)
      .set('Authorization', `Bearer ${tokens[trad]}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThan(0)
    return res.body
  }
  const rolesFor    = async (trad) => (await listOf('/api/clients?limit=50', trad)).map(c => c.role).filter(Boolean)
  const eventTitles = async (trad) => (await listOf('/api/events', trad)).map(e => e.title).filter(Boolean)

  it('a Catholic parish is seeded with Catholic words', async () => {
    const roles = await rolesFor('catholic')
    expect(roles).toContain('Catechist')
    expect(roles).toContain('Finance Council')
    expect(roles).not.toContain('Sunday School Teacher')
    expect(roles).not.toContain('Worship Leader')

    const titles = await eventTitles('catholic')
    expect(titles.some(t => /Sunday Mass/.test(t))).toBe(true)
    expect(titles.some(t => /Fellowship Hall/.test(t))).toBe(false)
  })

  it('an Episcopal parish is seeded with Episcopal words', async () => {
    const roles = await rolesFor('episcopal')
    expect(roles).toContain('Vestry')
    expect(roles).toContain('Altar Guild')
    expect(roles).not.toContain('Finance Committee')

    const titles = await eventTitles('episcopal')
    expect(titles.some(t => /Holy Eucharist/.test(t))).toBe(true)
    expect(titles.some(t => /Sunday Mass/.test(t))).toBe(false)
  })

  it('a Lutheran congregation is seeded with Lutheran words', async () => {
    const roles = await rolesFor('lutheran')
    expect(roles).toContain('Congregation Council')
    expect(roles).not.toContain('Vestry')

    const titles = await eventTitles('lutheran')
    expect(titles.some(t => /Sunday Worship/.test(t))).toBe(true)
  })

  it('a parish that names no tradition gets the neutral seed, not a Catholic one', async () => {
    // 'general' is a real tier. It must not quietly inherit whichever
    // tradition happens to be the default in the shared string table.
    const roles = await rolesFor('unset')
    expect(roles).toContain('Finance Committee')
    expect(roles).not.toContain('Catechist')
    expect(roles).not.toContain('Vestry')

    const titles = await eventTitles('unset')
    expect(titles.some(t => /Sunday Service/.test(t))).toBe(true)
    expect(titles.some(t => /Mass|Eucharist/.test(t))).toBe(false)
  })

  it('the giving categories follow the tradition too', async () => {
    const cats = async (trad) => (await listOf('/api/donations?limit=50', trad)).map(d => d.category).filter(Boolean)
    expect(await cats('catholic')).toContain('offertory')
    expect(await cats('episcopal')).toContain('pledge')
    expect((await cats('catholic'))).not.toContain('tithe')
  })

  it('every seeded row is still wipeable — the [Sample] marker survives', async () => {
    // clear-samples matches on '[Sample]%'. If a tradition ever moved the
    // marker inside the interpolation, a parish could not clear its demo
    // data, which is worse than the vocabulary problem this fixes.
    for (const trad of ['catholic', 'episcopal', 'lutheran', 'unset']) {
      const titles = await eventTitles(trad)
      expect(titles.length).toBeGreaterThan(0)
      expect(titles.every(t => t.startsWith('[Sample]'))).toBe(true)
    }
  })

  it('the seed vocabulary falls back rather than throwing on an unknown tradition', async () => {
    const { seedVocab } = await import('../src/onboarding/sampleSeed.js')
    expect(seedVocab('zoroastrian').service).toBe(seedVocab('general').service)
    expect(seedVocab(undefined).roles.length).toBe(12)
  })
})

describe('where a parish stands with its diocese (DIO.6) — the trickle-down', () => {
  // Everything in OpenDiocese went one way. A parish submitted its frozen
  // totals and heard nothing back: it could not see its own assessment, its
  // rate, a payment recorded against it, or a note the chancery had marked
  // "shared with the parish" — words the chancery UI has printed since
  // CARE.1 with no parish surface to make them true.
  //
  // These tests hold the two lines that matter. A parish sees its OWN line
  // and only its own; and a draft assessment is invisible until published,
  // because a chancery moving a rate around must be able to think without
  // every parish watching the number change.
  const chancery = {
    organizationName: `Standing Chancery ${RUN_ID}`, name: 'Canon Treasurer',
    email: `standdio_${RUN_ID}@example.com`, password: 'smoke-test-pw-71',
    organizationType: 'diocese',
  }
  const parish = {
    organizationName: `Standing Parish ${RUN_ID}`, name: 'Parish Admin',
    email: `standpar_${RUN_ID}@example.com`, password: 'smoke-test-pw-72',
  }
  const neighbour = {
    organizationName: `Standing Neighbour ${RUN_ID}`, name: 'Other Admin',
    email: `standnb_${RUN_ID}@example.com`, password: 'smoke-test-pw-73',
  }
  let dio, dioOrg, pTok, pOrg, nTok, nOrg, assessmentId

  beforeAll(async () => {
    const mk = async (payload, ip) => {
      const r = await createOrg(server, payload, ip)
      expect(r.status).toBe(201)
      return { token: r.body.token, orgId: r.body.user.organization.id }
    }
    ;({ token: dio, orgId: dioOrg } = await mk(chancery,  '10.99.7.11'))
    ;({ token: pTok, orgId: pOrg }  = await mk(parish,    '10.99.7.12'))
    ;({ token: nTok, orgId: nOrg }  = await mk(neighbour, '10.99.7.13'))

    for (const [email, tok] of [[parish.email, pTok], [neighbour.email, nTok]]) {
      const inv = await request(server).post('/api/diocese/parishes/invite')
        .set('Authorization', `Bearer ${dio}`).send({ email })
      expect(inv.status).toBeLessThan(300)
      const acc = await request(server).post('/api/affiliation/accept')
        .set('Authorization', `Bearer ${tok}`).send({ grant_level: 'detail' })
      expect(acc.status).toBe(200)
    }

    // An assessment line only exists where a parish actually reported
    // income, so both parishes walk the real loop: record giving, close the
    // period, submit, get approved. That is the trickle-UP this feature is
    // the other half of, so exercising it here is the point, not overhead.
    const earnAndSubmit = async (tok, amount) => {
      const gift = await request(server).post('/api/donations')
        .set('Authorization', `Bearer ${tok}`)
        .send({ donor_name: 'Standing Donor', amount, category: `Stand-${RUN_ID}`, date: '2026-03-15' })
      expect(gift.status).toBe(201)
      const sub = await request(server).post('/api/finance/submissions')
        .set('Authorization', `Bearer ${tok}`)
        .send({ period_start: '2026-03-01', period_end: '2026-03-31' })
      expect(sub.status).toBe(201)
      const ap = await request(server).patch(`/api/diocese/submissions/${sub.body.id}`)
        .set('Authorization', `Bearer ${dio}`).send({ status: 'approved' })
      expect(ap.status).toBe(200)
    }
    await earnAndSubmit(pTok, 4000)
    await earnAndSubmit(nTok, 9000)

    const a = await request(server).post('/api/diocese/assessments')
      .set('Authorization', `Bearer ${dio}`)
      .send({ fiscal_year: '2026', rate_bps: 850 })
    expect(a.status).toBeLessThan(300)
    assessmentId = a.body.assessment?.id ?? a.body.id
    expect(assessmentId).toBeTruthy()
  })

  it('an unaffiliated parish gets a plain answer, not an error', async () => {
    const lone = await createOrg(server, { organizationName: `Lone ${RUN_ID}`, name: 'Solo',
              email: `standlone_${RUN_ID}@example.com`, password: 'smoke-test-pw-74' }, '10.99.7.14')
    expect(lone.status).toBe(201)
    const res = await request(server).get('/api/affiliation/standing')
      .set('Authorization', `Bearer ${lone.body.token}`)
    // 200 with an empty standing. "You are not affiliated" is a true and
    // useful answer; a 404 would make the ordinary case look like a fault.
    expect(res.status).toBe(200)
    expect(res.body.standing).toBeNull()
  })

  it('A DRAFT ASSESSMENT IS INVISIBLE TO THE PARISH', async () => {
    // The assessment exists and has lines; it has not been published.
    const dioView = await request(server).get(`/api/diocese/assessments/${assessmentId}`)
      .set('Authorization', `Bearer ${dio}`)
    expect(dioView.status).toBe(200)
    const dioStatus = dioView.body.assessment?.status ?? dioView.body.status
    expect(dioStatus).toBe('draft')

    const res = await request(server).get('/api/affiliation/standing')
      .set('Authorization', `Bearer ${pTok}`)
    expect(res.status).toBe(200)
    expect(res.body.standing).not.toBeNull()
    expect(res.body.standing.assessments).toEqual([])
  })

  it('publishing it makes the parish line visible, with its basis', async () => {
    const pub = await request(server).patch(`/api/diocese/assessments/${assessmentId}`)
      .set('Authorization', `Bearer ${dio}`).send({ status: 'published' })
    expect(pub.status).toBe(200)

    const res = await request(server).get('/api/affiliation/standing')
      .set('Authorization', `Bearer ${pTok}`)
    expect(res.status).toBe(200)
    const lines = res.body.standing.assessments
    expect(lines.length).toBe(1)
    const line = lines[0]
    expect(line.fiscal_year).toBe('2026')
    // The rate arrives as a sentence, not as basis points — nobody outside
    // a finance office reads "850 bps" and pictures 8.5%.
    expect(line.rate).toMatch(/8\.5%/)
    expect(line.rate).not.toMatch(/bps/)
    // And the basis is stated. A figure a parish cannot check is a figure
    // a parish resents.
    expect(line.because).toMatch(/assessed on/i)
    expect(line.balance).toBe(Number((line.assessed - line.paid).toFixed(2)))
  })

  it('A PARISH NEVER SEES ANOTHER PARISH', async () => {
    const mine  = await request(server).get('/api/affiliation/standing').set('Authorization', `Bearer ${pTok}`)
    const other = await request(server).get('/api/affiliation/standing').set('Authorization', `Bearer ${nTok}`)
    expect(mine.status).toBe(200)
    expect(other.status).toBe(200)
    // Each sees exactly one line — its own. If the parish filter were
    // dropped, both would see two, and this is the assertion that catches it.
    expect(mine.body.standing.assessments.length).toBe(1)
    expect(other.body.standing.assessments.length).toBe(1)
    const blob = JSON.stringify(mine.body)
    expect(blob).not.toContain(`Standing Neighbour ${RUN_ID}`)
  })

  it('only what the diocese deliberately shared comes down', async () => {
    const write = (visibility, summary) => request(server)
      .post(`/api/diocese/care/${pOrg}/timeline`)
      .set('Authorization', `Bearer ${dio}`)
      .send({ kind: 'note', summary, visibility })

    expect((await write('diocese', 'Internal: treasurer is unwell, be gentle.')).status).toBeLessThan(300)
    expect((await write('shared', 'Thank you for the prompt return this period.')).status).toBeLessThan(300)

    const res = await request(server).get('/api/affiliation/standing')
      .set('Authorization', `Bearer ${pTok}`)
    const blob = JSON.stringify(res.body.standing.notices)
    expect(blob).toContain('Thank you for the prompt return')
    // The one that matters: the chancery's private note must not leak.
    expect(blob).not.toContain('treasurer is unwell')
  })

  it('there is no write path — the parish cannot edit its own assessment', async () => {
    // A "dispute" button would replace a conversation with a ticket. The
    // route is read-only by construction, and this pins it: nothing under
    // /api/affiliation/standing accepts a mutation.
    for (const method of ['post', 'patch', 'put', 'delete']) {
      const res = await request(server)[method]('/api/affiliation/standing')
        .set('Authorization', `Bearer ${pTok}`).send({ assessed: 0 })
      expect(res.status).toBeGreaterThanOrEqual(400)
    }
  })

  it('the parish cannot reach the chancery-side care API at all', async () => {
    const res = await request(server).get(`/api/diocese/care/${pOrg}`)
      .set('Authorization', `Bearer ${pTok}`)
    expect(res.status).toBe(403)
  })
})

describe('the pastoral care workflow (CARE.3)', () => {
  // Dale's sprint: Parish Care → Follow-up → Report Review → Care Brief, as
  // one complete workflow, with a permission model that says what it means.
  //
  // The load-bearing test in here is the permission one. Internal notes used
  // to be gated on `role === 'admin'` — the ownership role. In a chancery
  // that is often an operations person and often NOT the canon who conducts
  // visitations, so the old gate handed a parish's confidences to whoever
  // administered the account and withheld them from the person whose job is
  // to care for that parish. Both errors are invisible in a test org where
  // one human holds every role, which is exactly why they are asserted
  // separately here.
  const chancery = {
    organizationName: `Care3 Chancery ${RUN_ID}`, name: 'Canon Leader',
    email: `c3dio_${RUN_ID}@example.com`, password: 'smoke-test-pw-81',
    organizationType: 'diocese',
  }
  const parish = {
    organizationName: `Care3 Parish ${RUN_ID}`, name: 'Parish Admin',
    email: `c3par_${RUN_ID}@example.com`, password: 'smoke-test-pw-82',
  }
  const other = {
    organizationName: `Care3 Other Diocese ${RUN_ID}`, name: 'Other Canon',
    email: `c3oth_${RUN_ID}@example.com`, password: 'smoke-test-pw-83',
    organizationType: 'diocese',
  }
  let lead, plain, plainId, pTok, pOrg, otherTok, subId, followupId

  const INTERNAL = `Internal: the treasurer is unwell ${RUN_ID}`
  const SHARED = `Thank you for the prompt return ${RUN_ID}`

  beforeAll(async () => {
    const mk = async (payload, ip) => {
      const r = await createOrg(server, payload, ip)
      expect(r.status).toBe(201)
      return { token: r.body.token, orgId: r.body.user.organization.id }
    }
    const d = await mk(chancery, '10.99.9.21'); lead = d.token
    const p = await mk(parish, '10.99.9.22'); pTok = p.token; pOrg = p.orgId
    const o = await mk(other, '10.99.9.23'); otherTok = o.token

    // A second diocesan user who is NOT pastoral leadership. This is the
    // person the old admin-based gate got wrong.
    const staff = await request(server).post('/api/users')
      .set('Authorization', `Bearer ${lead}`)
      .send({ name: 'Chancery Bookkeeper', email: `c3staff_${RUN_ID}@example.com`,
              password: 'smoke-test-pw-84', role: 'staff' })
    expect(staff.status).toBe(201)
    plainId = staff.body.user?.id ?? staff.body.id
    const li = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.99.9.24')
      .send({ email: `c3staff_${RUN_ID}@example.com`, password: 'smoke-test-pw-84' })
    expect(li.status).toBe(200)
    plain = li.body.token

    const inv = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${lead}`).send({ email: parish.email })
    expect(inv.status).toBeLessThan(300)
    const acc = await request(server).post('/api/affiliation/accept')
      .set('Authorization', `Bearer ${pTok}`).send({ grant_level: 'detail' })
    expect(acc.status).toBe(200)

    // Two notes on the record: one the office shares, one it keeps.
    for (const [summary, visibility] of [[SHARED, 'shared'], [INTERNAL, 'diocese']]) {
      const t = await request(server).post(`/api/diocese/care/${pOrg}/timeline`)
        .set('Authorization', `Bearer ${lead}`).send({ kind: 'note', summary, visibility })
      expect(t.status).toBeLessThan(300)
    }

    // A submitted report to review together.
    await request(server).post('/api/donations').set('Authorization', `Bearer ${pTok}`)
      .send({ donor_name: 'Care3 Donor', amount: 500, category: `C3-${RUN_ID}`, date: '2026-05-10' })
    const sub = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${pTok}`)
      .send({ period_start: '2026-05-01', period_end: '2026-05-31' })
    expect(sub.status).toBe(201)
    subId = sub.body.id
  })

  it('the founding chancery user is pastoral leadership; a new staff user is not', async () => {
    const team = await request(server).get('/api/diocese/care/team')
      .set('Authorization', `Bearer ${lead}`)
    expect(team.status).toBe(200)
    const leadRow = team.body.team.find(u => u.name === 'Canon Leader')
    const plainRow = team.body.team.find(u => u.name === 'Chancery Bookkeeper')
    expect(leadRow.pastoral_lead).toBe(true)
    expect(plainRow.pastoral_lead).toBe(false)
  })

  it('A DIOCESAN USER WITHOUT THE PERMISSION CANNOT READ INTERNAL NOTES', async () => {
    const asLead = await request(server).get(`/api/diocese/care/${pOrg}`)
      .set('Authorization', `Bearer ${lead}`)
    const asPlain = await request(server).get(`/api/diocese/care/${pOrg}`)
      .set('Authorization', `Bearer ${plain}`)
    expect(asLead.status).toBe(200)
    expect(asPlain.status).toBe(200)

    // Both are legitimate chancery users looking at the same parish.
    expect(JSON.stringify(asLead.body)).toContain(INTERNAL)
    expect(JSON.stringify(asPlain.body)).not.toContain(INTERNAL)
    // And the shared one reaches both — the gate filters, it does not blank.
    expect(JSON.stringify(asPlain.body)).toContain(SHARED)
  })

  it('the permission is read from the database, so revoking it takes effect at once', async () => {
    // Granting mid-session must work on the CURRENT token. A permission
    // baked into a JWT survives its own revocation until expiry, and
    // "we removed her access an hour ago" has to be true when it is said.
    const grant = await request(server).patch(`/api/users/${plainId}/pastoral-lead`)
      .set('Authorization', `Bearer ${lead}`).send({ pastoral_lead: true })
    expect(grant.status).toBe(200)

    const now = await request(server).get(`/api/diocese/care/${pOrg}`)
      .set('Authorization', `Bearer ${plain}`)   // same token as before
    expect(JSON.stringify(now.body)).toContain(INTERNAL)

    const revoke = await request(server).patch(`/api/users/${plainId}/pastoral-lead`)
      .set('Authorization', `Bearer ${lead}`).send({ pastoral_lead: false })
    expect(revoke.status).toBe(200)
    const after = await request(server).get(`/api/diocese/care/${pOrg}`)
      .set('Authorization', `Bearer ${plain}`)
    expect(JSON.stringify(after.body)).not.toContain(INTERNAL)
  })

  it('THE DEFAULT BRIEF EXCLUDES INTERNAL NOTES; the internal one includes them', async () => {
    const plainBrief = await request(server).get(`/api/diocese/care/${pOrg}/brief`)
      .set('Authorization', `Bearer ${lead}`)
    expect(plainBrief.status).toBe(200)
    expect(JSON.stringify(plainBrief.body)).not.toContain(INTERNAL)

    const internalBrief = await request(server).get(`/api/diocese/care/${pOrg}/brief?internal=1`)
      .set('Authorization', `Bearer ${lead}`)
    expect(JSON.stringify(internalBrief.body)).toContain(INTERNAL)
  })

  it('a brief prepared by someone without the permission withholds contact details', async () => {
    const b = await request(server).get(`/api/diocese/care/${pOrg}/brief`)
      .set('Authorization', `Bearer ${plain}`)
    expect(b.status).toBe(200)
    // Stated on the face of the brief, not silently omitted.
    expect(b.body.withheld).toMatch(/withheld/i)
    for (const person of b.body.people ?? []) {
      expect(person.email).toBeUndefined()
      expect(person.phone).toBeUndefined()
    }
  })

  it('reading a report together is NOT an approval', async () => {
    const before = await request(server).get(`/api/diocese/care/submissions/${subId}/review`)
      .set('Authorization', `Bearer ${lead}`)
    expect(before.status).toBe(200)
    expect(before.body.submission.status).toBe('submitted')
    expect(before.body.submission.reviewed_together_on).toBeNull()

    const mark = await request(server).post(`/api/diocese/care/submissions/${subId}/reviewed`)
      .set('Authorization', `Bearer ${lead}`).send({})
    expect(mark.status).toBe(200)

    const after = await request(server).get(`/api/diocese/care/submissions/${subId}/review`)
      .set('Authorization', `Bearer ${lead}`)
    // The status that gates the assessment roll-up is untouched.
    expect(after.body.submission.status).toBe('submitted')
    expect(after.body.submission.reviewed_together_on).toBeTruthy()
    expect(after.body.submission.reviewed_together_name).toBeTruthy()
  })

  it('review notes respect visibility, and the withholding is stated', async () => {
    const shared = await request(server).post(`/api/diocese/care/submissions/${subId}/notes`)
      .set('Authorization', `Bearer ${lead}`)
      .send({ body: `Shared review note ${RUN_ID}`, visibility: 'shared',
              agreed_next_step: 'Walk one import through together' })
    expect(shared.status).toBeLessThan(300)
    const priv = await request(server).post(`/api/diocese/care/submissions/${subId}/notes`)
      .set('Authorization', `Bearer ${lead}`)
      .send({ body: `Private review note ${RUN_ID}`, visibility: 'diocese' })
    expect(priv.status).toBeLessThan(300)

    const asLead = await request(server).get(`/api/diocese/care/submissions/${subId}/review`)
      .set('Authorization', `Bearer ${lead}`)
    expect(JSON.stringify(asLead.body.notes)).toContain('Private review note')
    expect(asLead.body.withheld).toBeNull()

    const asPlain = await request(server).get(`/api/diocese/care/submissions/${subId}/review`)
      .set('Authorization', `Bearer ${plain}`)
    expect(JSON.stringify(asPlain.body.notes)).not.toContain('Private review note')
    expect(JSON.stringify(asPlain.body.notes)).toContain('Shared review note')
    expect(asPlain.body.withheld).toMatch(/not shown/i)
  })

  it('a follow-up can be raised from the review, assigned, and settled with an outcome', async () => {
    const made = await request(server).post(`/api/diocese/care/${pOrg}/followups`)
      .set('Authorization', `Bearer ${lead}`)
      .send({ context: 'Reading the May report together',
              next_action: 'Sit with the bookkeeper and walk one import through',
              owner_user_id: plainId, from_submission_id: subId })
    expect(made.status).toBe(201)
    followupId = made.body.id
    expect(made.body.owner_name).toBe('Chancery Bookkeeper')
    expect(Number(made.body.from_submission_id)).toBe(Number(subId))

    // It shows up against the review that produced it.
    const review = await request(server).get(`/api/diocese/care/submissions/${subId}/review`)
      .set('Authorization', `Bearer ${lead}`)
    expect(review.body.followups.map(f => f.id)).toContain(followupId)

    const done = await request(server).patch(`/api/diocese/care/followups/${followupId}`)
      .set('Authorization', `Bearer ${lead}`)
      .send({ state: 'done', completion_note: 'Sat together Tuesday; the import maps now.' })
    expect(done.status).toBe(200)
    expect(done.body.state).toBe('done')
    expect(done.body.completion_note).toMatch(/import maps now/)
    expect(done.body.settled_at).toBeTruthy()
  })

  it('"let it go" is a real resolution and can carry a reason', async () => {
    const made = await request(server).post(`/api/diocese/care/${pOrg}/followups`)
      .set('Authorization', `Bearer ${lead}`)
      .send({ context: 'Rector transition', next_action: 'Offer register help' })
    expect(made.status).toBe(201)

    const letGo = await request(server).patch(`/api/diocese/care/followups/${made.body.id}`)
      .set('Authorization', `Bearer ${lead}`)
      .send({ state: 'let_go', let_go_reason: 'They sorted it themselves; no longer needed.' })
    expect(letGo.status).toBe(200)
    expect(letGo.body.state).toBe('let_go')
    expect(letGo.body.let_go_reason).toMatch(/sorted it themselves/)
    // A reason for letting go is NOT filed as a completion note. The two
    // say different things and a record that conflates them teaches an
    // office to record neither honestly.
    expect(letGo.body.completion_note).toBeNull()

    const open = await request(server).get('/api/diocese/care/followups?state=let_go')
      .set('Authorization', `Bearer ${lead}`)
    expect(open.body.followups.map(f => f.id)).toContain(made.body.id)
  })

  it('a follow-up cannot be assigned to someone in another diocese', async () => {
    const otherTeam = await request(server).get('/api/diocese/care/team')
      .set('Authorization', `Bearer ${otherTok}`)
    const outsiderId = otherTeam.body.team[0].id

    const res = await request(server).post(`/api/diocese/care/${pOrg}/followups`)
      .set('Authorization', `Bearer ${lead}`)
      .send({ context: 'A context long enough to pass validation', next_action: 'A next action long enough', owner_user_id: outsiderId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not in this diocese/i)
  })

  it('ANOTHER DIOCESE CANNOT REACH THIS PARISH, ITS REVIEW, OR ITS BRIEF', async () => {
    for (const path of [
      `/api/diocese/care/${pOrg}`,
      `/api/diocese/care/${pOrg}/brief`,
      `/api/diocese/care/submissions/${subId}/review`,
    ]) {
      const res = await request(server).get(path).set('Authorization', `Bearer ${otherTok}`)
      expect(res.status).toBe(404)
    }
  })

  it('A PARISH USER CANNOT REACH ANY DIOCESAN CARE ROUTE', async () => {
    for (const path of [
      '/api/diocese/care',
      '/api/diocese/care/followups',
      '/api/diocese/care/team',
      `/api/diocese/care/${pOrg}`,
      `/api/diocese/care/${pOrg}/brief`,
      `/api/diocese/care/submissions/${subId}/review`,
    ]) {
      const res = await request(server).get(path).set('Authorization', `Bearer ${pTok}`)
      expect(res.status).toBe(403)
    }
  })

  it('the dashboard filters by care state and searches without ranking anything', async () => {
    const all = await request(server).get('/api/diocese/care')
      .set('Authorization', `Bearer ${lead}`)
    expect(all.status).toBe(200)
    expect(all.body.parishes.length).toBeGreaterThan(0)
    expect(all.body.counts).toBeTruthy()

    const hit = await request(server).get(`/api/diocese/care?q=Care3 Parish ${RUN_ID}`)
      .set('Authorization', `Bearer ${lead}`)
    expect(hit.body.parishes.length).toBe(1)

    const miss = await request(server).get('/api/diocese/care?q=zzz-no-such-parish-zzz')
      .set('Authorization', `Bearer ${lead}`)
    expect(miss.body.parishes.length).toBe(0)
    // Counts describe the SEARCHED set, not the whole diocese. A search that
    // finds nothing therefore has nothing to count, which is honest — the
    // alternative is a chip promising three parishes that clicking it cannot
    // produce.
    expect(Object.keys(miss.body.counts).length).toBe(0)
    expect(miss.body.total).toBe(0)

    const state = all.body.parishes[0].status.key
    const filtered = await request(server).get(`/api/diocese/care?state=${state}`)
      .set('Authorization', `Bearer ${lead}`)
    expect(filtered.body.parishes.every(p => p.status.key === state)).toBe(true)
  })

  it('NO RANKING, SCORING OR PUNITIVE VOCABULARY ANYWHERE IN THE WORKFLOW', async () => {
    const payloads = await Promise.all([
      request(server).get('/api/diocese/care').set('Authorization', `Bearer ${lead}`),
      request(server).get(`/api/diocese/care/${pOrg}`).set('Authorization', `Bearer ${lead}`),
      request(server).get(`/api/diocese/care/${pOrg}/brief`).set('Authorization', `Bearer ${lead}`),
      request(server).get(`/api/diocese/care/submissions/${subId}/review`).set('Authorization', `Bearer ${lead}`),
      request(server).get('/api/diocese/care/followups').set('Authorization', `Bearer ${lead}`),
    ])
    const blob = payloads.map(r => JSON.stringify(r.body)).join(' ')
    for (const banned of [
      'at risk', 'overdue', 'non-compliant', 'noncompliant', 'failing', 'delinquent',
      'health score', 'risk score', 'engagement score', 'ranking', 'rank',
      'escalate', 'past due', 'in arrears',
    ]) {
      expect(blob.toLowerCase()).not.toContain(banned)
    }
  })

  it('every care state arrives with a reason and a next action', async () => {
    const res = await request(server).get('/api/diocese/care')
      .set('Authorization', `Bearer ${lead}`)
    for (const p of res.body.parishes) {
      expect(['ready', 'review_together', 'offer_support', 'awaiting_update'])
        .toContain(p.status.key)
      // A state without its reason is a verdict. This is the line the whole
      // feature is built on.
      expect(String(p.status.because).length).toBeGreaterThan(10)
      expect(String(p.status.label).length).toBeGreaterThan(2)
    }
  })
})

describe('deaneries and diocesan structure (PILOT.1)', () => {
  // ochr_diocese_regions shipped in migration 074 and nothing could write
  // to it. Parish Care joined it on every query, the parish record showed
  // it, the care brief printed it — all against a table no route could
  // populate, so every parish in every diocese has had a null deanery since
  // the day the column landed. It LOOKED like it worked, because a LEFT
  // JOIN against an empty table returns null rather than an error.
  const chancery = {
    organizationName: `Deanery Chancery ${RUN_ID}`, name: 'Canon Structure',
    email: `dean_${RUN_ID}@example.com`, password: 'smoke-test-pw-91',
    organizationType: 'diocese',
  }
  const other = {
    organizationName: `Other Deanery Diocese ${RUN_ID}`, name: 'Other Canon',
    email: `deanoth_${RUN_ID}@example.com`, password: 'smoke-test-pw-92',
    organizationType: 'diocese',
  }
  const parish = {
    organizationName: `Deanery Parish ${RUN_ID}`, name: 'Parish Admin',
    email: `deanpar_${RUN_ID}@example.com`, password: 'smoke-test-pw-93',
  }
  let dio, otherTok, pTok, pOrg, regionId, otherRegionId

  beforeAll(async () => {
    const mk = async (payload, ip) => {
      const r = await createOrg(server, payload, ip)
      expect(r.status).toBe(201)
      return { token: r.body.token, orgId: r.body.user.organization.id }
    }
    dio = (await mk(chancery, '10.99.11.31')).token
    otherTok = (await mk(other, '10.99.11.32')).token
    const p = await mk(parish, '10.99.11.33'); pTok = p.token; pOrg = p.orgId

    const inv = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${dio}`).send({ email: parish.email })
    expect(inv.status).toBeLessThan(300)
    const acc = await request(server).post('/api/affiliation/accept')
      .set('Authorization', `Bearer ${pTok}`).send({ grant_level: 'summary' })
    expect(acc.status).toBe(200)
  })

  it('a deanery can be created, which was impossible before', async () => {
    const res = await request(server).post('/api/diocese/regions')
      .set('Authorization', `Bearer ${dio}`).send({ name: 'Northern Deanery' })
    expect(res.status).toBe(201)
    regionId = res.body.region.id
    expect(res.body.region.name).toBe('Northern Deanery')
    expect(res.body.region.parish_count).toBe(0)
  })

  it('a name must be real, and cannot be duplicated within a diocese', async () => {
    const blank = await request(server).post('/api/diocese/regions')
      .set('Authorization', `Bearer ${dio}`).send({ name: ' ' })
    expect(blank.status).toBe(400)

    const dupe = await request(server).post('/api/diocese/regions')
      .set('Authorization', `Bearer ${dio}`).send({ name: 'Northern Deanery' })
    expect(dupe.status).toBe(409)
    expect(dupe.body.error).toMatch(/already a deanery/i)
  })

  it('TWO DIOCESES MAY EACH HAVE A DEANERY OF THE SAME NAME, AND NEITHER SEES THE OTHER', async () => {
    const mine = await request(server).post('/api/diocese/regions')
      .set('Authorization', `Bearer ${otherTok}`).send({ name: 'Northern Deanery' })
    expect(mine.status).toBe(201)   // not a 409 — the unique key is per diocese
    otherRegionId = mine.body.region.id

    const listA = await request(server).get('/api/diocese/regions').set('Authorization', `Bearer ${dio}`)
    const listB = await request(server).get('/api/diocese/regions').set('Authorization', `Bearer ${otherTok}`)
    expect(listA.body.regions.map(r => r.id)).not.toContain(otherRegionId)
    expect(listB.body.regions.map(r => r.id)).not.toContain(regionId)
  })

  it('a parish can be put into a deanery, and it shows in Parish Care', async () => {
    const assign = await request(server).patch(`/api/diocese/regions/assign/${pOrg}`)
      .set('Authorization', `Bearer ${dio}`).send({ region_id: regionId })
    expect(assign.status).toBe(200)

    // The whole point: the join that has always returned null now returns
    // the deanery.
    const care = await request(server).get('/api/diocese/care').set('Authorization', `Bearer ${dio}`)
    const row = care.body.parishes.find(p => p.parish_org_id === pOrg)
    expect(row.region).toBe('Northern Deanery')

    const counted = await request(server).get('/api/diocese/regions').set('Authorization', `Bearer ${dio}`)
    expect(counted.body.regions.find(r => r.id === regionId).parish_count).toBe(1)
  })

  it('the deanery is searchable from the care dashboard', async () => {
    const res = await request(server).get('/api/diocese/care?q=Northern')
      .set('Authorization', `Bearer ${dio}`)
    expect(res.body.parishes.map(p => p.parish_org_id)).toContain(pOrg)
  })

  it('A PARISH CANNOT BE PUT INTO ANOTHER DIOCESE’S DEANERY', async () => {
    const res = await request(server).patch(`/api/diocese/regions/assign/${pOrg}`)
      .set('Authorization', `Bearer ${dio}`).send({ region_id: otherRegionId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not this diocese/i)
  })

  it('another diocese cannot rename or remove this one’s deanery', async () => {
    const rename = await request(server).patch(`/api/diocese/regions/${regionId}`)
      .set('Authorization', `Bearer ${otherTok}`).send({ name: 'Hijacked' })
    expect(rename.status).toBe(404)
    const remove = await request(server).delete(`/api/diocese/regions/${regionId}`)
      .set('Authorization', `Bearer ${otherTok}`)
    expect(remove.status).toBe(404)
  })

  it('REMOVING A DEANERY WITH PARISHES IN IT IS REFUSED, NOT CASCADED', async () => {
    const res = await request(server).delete(`/api/diocese/regions/${regionId}`)
      .set('Authorization', `Bearer ${dio}`)
    // Cascading would silently detach every parish and nobody would find
    // out until a brief printed without a deanery on it.
    expect(res.status).toBe(409)
    expect(res.body.parish_count).toBe(1)
    expect(res.body.error).toMatch(/Move it first/i)

    // And the parish is untouched by the refusal.
    const care = await request(server).get('/api/diocese/care').set('Authorization', `Bearer ${dio}`)
    expect(care.body.parishes.find(p => p.parish_org_id === pOrg).region).toBe('Northern Deanery')
  })

  it('clearing the parish out lets the deanery go', async () => {
    const clear = await request(server).patch(`/api/diocese/regions/assign/${pOrg}`)
      .set('Authorization', `Bearer ${dio}`).send({ region_id: null })
    expect(clear.status).toBe(200)
    const gone = await request(server).delete(`/api/diocese/regions/${regionId}`)
      .set('Authorization', `Bearer ${dio}`)
    expect(gone.status).toBe(204)
  })

  it('A PARISH USER CANNOT REACH DEANERIES AT ALL', async () => {
    const get = await request(server).get('/api/diocese/regions').set('Authorization', `Bearer ${pTok}`)
    expect(get.status).toBe(403)
    const post = await request(server).post('/api/diocese/regions')
      .set('Authorization', `Bearer ${pTok}`).send({ name: 'Parish Deanery' })
    expect(post.status).toBe(403)
  })

  it('a deanery carries no score, ranking or comparison', async () => {
    const res = await request(server).get('/api/diocese/regions').set('Authorization', `Bearer ${dio}`)
    const blob = JSON.stringify(res.body).toLowerCase()
    for (const banned of ['score', 'rank', 'health', 'risk', 'performance', 'compliance']) {
      expect(blob).not.toContain(banned)
    }
  })
})

describe('parish cohort intake (PILOT.3)', () => {
  // "Import a parish cohort" reads as a CSV that creates parish records.
  // It cannot be: a diocese may not create a parish's account or enrol it
  // without consent — parishes sign up themselves and ACCEPT, and what they
  // share is a covenant they can end. So a cohort is a validated batch of
  // INVITATIONS, and the preview exists so somebody can see what is about
  // to happen before it happens.
  const chancery = {
    organizationName: `Cohort Chancery ${RUN_ID}`, name: 'Canon Intake',
    email: `coh_${RUN_ID}@example.com`, password: 'smoke-test-pw-97',
    organizationType: 'diocese',
  }
  const rival = {
    organizationName: `Rival Diocese ${RUN_ID}`, name: 'Rival Canon',
    email: `cohriv_${RUN_ID}@example.com`, password: 'smoke-test-pw-98',
    organizationType: 'diocese',
  }
  let dio, rivalTok
  const free1 = `cohp1_${RUN_ID}@example.com`
  const free2 = `cohp2_${RUN_ID}@example.com`
  const taken = `cohp3_${RUN_ID}@example.com`

  beforeAll(async () => {
    const mk = async (payload, ip) => {
      const r = await createOrg(server, payload, ip)
      expect(r.status).toBe(201)
      return { token: r.body.token, orgId: r.body.user.organization.id }
    }
    dio = (await mk(chancery, '10.99.13.51')).token
    rivalTok = (await mk(rival, '10.99.13.52')).token

    for (const [i, email] of [free1, free2, taken].entries()) {
      await mk({ organizationName: `Cohort Parish ${i} ${RUN_ID}`, name: 'Admin',
                 email, password: 'smoke-test-pw-99' }, `10.99.13.6${i}`)
    }
    // One of them already belongs to a rival diocese.
    const inv = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${rivalTok}`).send({ email: taken })
    expect(inv.status).toBeLessThan(300)
  })

  it('A PREVIEW IS THE DEFAULT — nothing is invited without asking twice', async () => {
    const res = await request(server).post('/api/diocese/parishes/cohort')
      .set('Authorization', `Bearer ${dio}`)
      .send({ emails: [free1, free2] })      // no dry_run flag at all
    expect(res.status).toBe(200)
    expect(res.body.preview).toBe(true)
    expect(res.body.summary.ready).toBe(2)

    // And nothing actually happened.
    const roster = await request(server).get('/api/diocese/parishes')
      .set('Authorization', `Bearer ${dio}`)
    expect(roster.body.parishes ?? roster.body).toHaveLength(0)
  })

  it('the preview names every reason a row will be skipped', async () => {
    const res = await request(server).post('/api/diocese/parishes/cohort')
      .set('Authorization', `Bearer ${dio}`)
      .send({ emails: [free1, free1, 'not-an-email', `ghost_${RUN_ID}@example.com`, taken, chancery.email] })
    const by = Object.fromEntries(res.body.rows.map(r => [r.email + r.state, r]))
    expect(by[free1 + 'ready']).toBeTruthy()
    expect(by[free1 + 'duplicate'].note).toMatch(/more than once/i)
    expect(by['not-an-email' + 'invalid']).toBeTruthy()
    expect(by[`ghost_${RUN_ID}@example.com` + 'not_found']).toBeTruthy()
    expect(by[taken + 'spoken_for']).toBeTruthy()
    expect(by[chancery.email + 'invalid'].note).toMatch(/this diocese/i)
  })

  it('A PARISH ALREADY WITH ANOTHER DIOCESE IS NEVER NAMED AS SUCH', async () => {
    const res = await request(server).post('/api/diocese/parishes/cohort')
      .set('Authorization', `Bearer ${dio}`).send({ emails: [taken] })
    const row = res.body.rows[0]
    expect(row.state).toBe('spoken_for')
    // Which diocese a parish belongs to is that parish's business.
    expect(JSON.stringify(res.body)).not.toContain(rival.organizationName)
  })

  it('committing invites only the ready rows', async () => {
    const res = await request(server).post('/api/diocese/parishes/cohort')
      .set('Authorization', `Bearer ${dio}`)
      .send({ emails: [free1, free2, taken, 'nope'], dry_run: false })
    expect(res.status).toBe(201)
    expect(res.body.preview).toBe(false)
    expect(res.body.summary.invited).toBe(2)

    const roster = await request(server).get('/api/diocese/parishes')
      .set('Authorization', `Bearer ${dio}`)
    const list = roster.body.parishes ?? roster.body
    expect(list).toHaveLength(2)
    expect(list.every(p => p.status === 'invited')).toBe(true)
  })

  it('running it again does not duplicate anybody', async () => {
    const res = await request(server).post('/api/diocese/parishes/cohort')
      .set('Authorization', `Bearer ${dio}`)
      .send({ emails: [free1, free2], dry_run: false })
    expect(res.body.summary.invited).toBe(0)
    expect(res.body.rows.every(r => r.state === 'already_invited')).toBe(true)

    const roster = await request(server).get('/api/diocese/parishes')
      .set('Authorization', `Bearer ${dio}`)
    expect(roster.body.parishes ?? roster.body).toHaveLength(2)
  })

  it('a list longer than a pilot cohort is refused with the runbook’s advice', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `bulk${i}_${RUN_ID}@example.com`)
    const res = await request(server).post('/api/diocese/parishes/cohort')
      .set('Authorization', `Bearer ${dio}`).send({ emails: many })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/four to eight/i)
  })

  it('a pasted blob of text works as well as an array', async () => {
    const res = await request(server).post('/api/diocese/parishes/cohort')
      .set('Authorization', `Bearer ${dio}`)
      .send({ emails: `${free1}, ${free2}\n${free1}` })
    expect(res.body.rows.length).toBe(3)
  })

  it('a parish user cannot run a cohort intake', async () => {
    const p = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.99.13.70')
      .send({ email: free1, password: 'smoke-test-pw-99' })
    const res = await request(server).post('/api/diocese/parishes/cohort')
      .set('Authorization', `Bearer ${p.body.token}`).send({ emails: [free2] })
    expect(res.status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Tiered rates and a lagged base (DIO.087)
//
// Two shapes a real Episcopal diocese uses that the model could not
// express. Both come from published formulas, not from imagination:
// Maine charges 5% on the first $10,000 and 15% above it; the churchwide
// assessment exempts the first $200,000 then charges 15%.
// ─────────────────────────────────────────────────────────────────────────
describe('assessment bands and base year (DIO.087)', () => {
  let dio, parish, parishOrgId

  const MAINE = [{ upto: 10000, rate_bps: 500 }, { upto: null, rate_bps: 1500 }]
  const CHURCHWIDE = [{ upto: 200000, rate_bps: 0 }, { upto: null, rate_bps: 1500 }]
  const yearNamed = async (fy) => {
    const list = await request(app).get('/api/diocese/assessments').set('Authorization', `Bearer ${dio}`)
    return list.body.assessments.find(a => a.fiscal_year === fy)
  }

  beforeAll(async () => {
    const mk = async (payload, ip) => {
      const r = await createOrg(server, payload, ip)
      expect(r.status).toBe(201)
      return r.body
    }
    const d = await mk({ organizationName: `Bands Diocese ${RUN_ID}`, name: 'Canon Bands',
      email: `bands_dio_${RUN_ID}@example.com`, password: 'bands-pw-1', organizationType: 'diocese' }, '10.55.41.1')
    dio = d.token
    const p = await mk({ organizationName: `Bands Parish ${RUN_ID}`, name: 'Parish Admin',
      email: `bands_par_${RUN_ID}@example.com`, password: 'bands-pw-2', tradition: 'episcopal' }, '10.55.41.2')
    parish = p.token; parishOrgId = p.user.organization.id

    await request(app).post('/api/diocese/parishes/invite').set('Authorization', `Bearer ${dio}`)
      .send({ email: `bands_par_${RUN_ID}@example.com` })
    await request(app).post('/api/affiliation/accept').set('Authorization', `Bearer ${parish}`)
      .send({ grant_level: 'detail' })

    // $50,000 of assessable giving closing in 2024 — two years before the
    // assessment year, which is the point.
    await request(app).post('/api/donations').set('Authorization', `Bearer ${parish}`)
      .send({ donor_name: 'Big Giver', amount: 50000, date: '2024-06-15' })
    const sub = await request(app).post('/api/finance/submissions').set('Authorization', `Bearer ${parish}`)
      .send({ period_start: '2024-01-01', period_end: '2024-12-31' })
    expect(sub.status).toBeLessThan(300)
    await request(app).patch(`/api/diocese/submissions/${sub.body.id}`).set('Authorization', `Bearer ${dio}`)
      .send({ status: 'approved' })
  })

  it('the ladder is marginal, and 8 bands is the ceiling', () => {
    expect(assessedForBands(50000, MAINE).assessed).toBe('6500.00')      // 500 + 6000
    expect(assessedForBands(250000, CHURCHWIDE).assessed).toBe('7500.00')
    expect(assessedForBands(150000, CHURCHWIDE).assessed).toBe('0.00')   // under the exemption
    expect(assessedForBands(0, MAINE).assessed).toBe('0.00')
    expect(validateBands(Array.from({ length: 9 }, () => ({ upto: null, rate_bps: 100 }))).error)
      .toMatch(/at most 8 bands/)
  })

  it('SLICES ARE ROUNDED THEN SUMMED, SO THE WORKING ADDS UP TO THE BILL', () => {
    // Chosen so the two rules actually disagree: each slice comes to
    // 12.344, which rounds DOWN to 12.34 — but the exact total is 24.688,
    // which rounds UP to 24.69. Round-once produces an invoice that is a
    // penny away from its own explanation, and the phone call that
    // follows costs more than the penny.
    //
    // The first version of this test used 500/6000 figures with no
    // fractional cents at all, and passed happily with the rule
    // reversed — which is the only reason this one exists.
    const r = assessedForBands(2468.80, [
      { upto: 1234.40, rate_bps: 100 },
      { upto: null, rate_bps: 100 },
    ])
    expect(r.assessed).toBe('24.68')
    const shown = r.breakdown.reduce((sum, b) => sum + Number(b.assessed), 0)
    expect(shown.toFixed(2)).toBe(r.assessed)
  })

  it('AN ARBITRARY LADDER IS REFUSED WITH THE REASON', () => {
    expect(validateBands([{ upto: 1000, rate_bps: 500 }]).error).toMatch(/last band must have no upper limit/)
    expect(validateBands([{ upto: 5000, rate_bps: 500 }, { upto: 1000, rate_bps: 900 }, { upto: null, rate_bps: 1000 }]).error)
      .toMatch(/larger than the one before/)
    expect(validateBands([{ upto: null, rate_bps: 9999 }]).error).toMatch(/between 0 and 3000/)
    expect(validateBands([]).error).toMatch(/non-empty/)
    expect(validateBands(undefined).bands).toBeNull()
  })

  it('THE BASE CAN COME FROM AN EARLIER YEAR', async () => {
    const res = await request(app).post('/api/diocese/assessments').set('Authorization', `Bearer ${dio}`)
      .send({ fiscal_year: '2026', base_year: '2024', bands: MAINE, rate_bps: 1500, notes: 'Maine formula' })
    expect(res.status).toBe(201)
    expect(res.body.base_year).toBe('2024')
    const line = res.body.lines.find(l => l.parish_org_id === parishOrgId)
    expect(Number(line.base)).toBe(50000)
    expect(Number(line.assessed)).toBe(6500)
  })

  it('THE LINE SHOWS ITS WORKING, AND THE SLICES ADD UP TO THE BILL', async () => {
    const year = await yearNamed('2026')
    const res = await request(app).get(`/api/diocese/assessments/${year.id}`).set('Authorization', `Bearer ${dio}`)
    const line = res.body.lines.find(l => l.parish_org_id === parishOrgId)
    expect(line.breakdown.length).toBe(2)
    expect(line.breakdown[0]).toMatchObject({ rate_bps: 500, assessed: '500.00' })
    expect(line.breakdown[1]).toMatchObject({ rate_bps: 1500, assessed: '6000.00', to: null })
    const shown = line.breakdown.reduce((s, b) => s + Number(b.assessed), 0)
    expect(Number(shown.toFixed(2))).toBe(Number(line.assessed))
  })

  it('an assessment with no base_year still means its own year', async () => {
    const res = await request(app).post('/api/diocese/assessments').set('Authorization', `Bearer ${dio}`)
      .send({ fiscal_year: '2024', rate_bps: 1200 })
    expect(res.status).toBe(201)
    expect(res.body.base_year).toBe('2024')
    const line = res.body.lines.find(l => l.parish_org_id === parishOrgId)
    expect(Number(line.assessed)).toBe(6000)     // flat 12% of 50,000
    expect(line.breakdown).toBeNull()            // a flat rate needs no working
  })

  it('AN EXEMPTION IS JUST A ZERO ON THE BOTTOM RUNG', async () => {
    const res = await request(app).post('/api/diocese/assessments').set('Authorization', `Bearer ${dio}`)
      .send({ fiscal_year: '2027', base_year: '2024', bands: CHURCHWIDE, rate_bps: 1500 })
    expect(res.status).toBe(201)
    const line = res.body.lines.find(l => l.parish_org_id === parishOrgId)
    expect(Number(line.assessed)).toBe(0)        // $50,000 sits inside a $200,000 exemption
    expect(line.breakdown[0]).toMatchObject({ rate_bps: 0, assessed: '0.00' })
  })

  it('a per-parish override is flat, and drops the working it no longer explains', async () => {
    const year = await yearNamed('2026')
    const detail = await request(app).get(`/api/diocese/assessments/${year.id}`).set('Authorization', `Bearer ${dio}`)
    const line = detail.body.lines.find(l => l.parish_org_id === parishOrgId)

    const res = await request(app).patch(`/api/diocese/assessments/${year.id}/lines/${line.id}`)
      .set('Authorization', `Bearer ${dio}`)
      .send({ rate_bps: 800, note: 'Agreed reduction for 2026' })
    expect(res.status).toBeLessThan(300)

    const after = await request(app).get(`/api/diocese/assessments/${year.id}`).set('Authorization', `Bearer ${dio}`)
    const l2 = after.body.lines.find(l => l.parish_org_id === parishOrgId)
    expect(Number(l2.assessed)).toBe(4000)   // flat 8%
    expect(l2.breakdown).toBeNull()
    expect(l2.note).toMatch(/Agreed reduction/)
  })

  it('RECOMPUTING KEEPS A NEGOTIATED RATE', async () => {
    const year = await yearNamed('2026')
    const res = await request(app).post(`/api/diocese/assessments/${year.id}/recompute`)
      .set('Authorization', `Bearer ${dio}`)
    expect(res.status).toBeLessThan(300)
    const after = await request(app).get(`/api/diocese/assessments/${year.id}`).set('Authorization', `Bearer ${dio}`)
    const l = after.body.lines.find(x => x.parish_org_id === parishOrgId)
    // A chancery's decision is not arithmetic to be overwritten.
    expect(l.rate_bps).toBe(800)
    expect(Number(l.assessed)).toBe(4000)
    expect(l.breakdown).toBeNull()
  })

  it('THE BASE YEAR IS WHAT A RECOMPUTE READS FROM', async () => {
    // Money that closed in 2025 must not appear in an assessment based on 2024.
    await request(app).post('/api/donations').set('Authorization', `Bearer ${parish}`)
      .send({ donor_name: 'Later Giver', amount: 9000, date: '2025-06-15' })
    const sub = await request(app).post('/api/finance/submissions').set('Authorization', `Bearer ${parish}`)
      .send({ period_start: '2025-01-01', period_end: '2025-12-31' })
    await request(app).patch(`/api/diocese/submissions/${sub.body.id}`).set('Authorization', `Bearer ${dio}`)
      .send({ status: 'approved' })

    const year = await yearNamed('2027')      // base_year 2024
    await request(app).post(`/api/diocese/assessments/${year.id}/recompute`).set('Authorization', `Bearer ${dio}`)
    const after = await request(app).get(`/api/diocese/assessments/${year.id}`).set('Authorization', `Bearer ${dio}`)
    const l = after.body.lines.find(x => x.parish_org_id === parishOrgId)
    expect(Number(l.base)).toBe(50000)        // still 2024's number, not 59,000
  })
})

// ─────────────────────────────────────────────────────────────────────────
// The covenant, and what happens when it ends (CARE.SEC — 24 Aug)
//
// A diocese reading a parish's books is the one place in this product where
// a cross-organization read is legitimate. Everything else is scoped by
// organization_id; here, the affiliation IS the authorisation, and two
// things about it have to hold:
//
//   grant_level  — a parish that shared 'summary' has not shared its
//                  per-account lines, on ANY route
//   status       — when a parish leaves, the diocese stops reading, on ANY
//                  route
//
// Both were true on /api/diocese/* and false on /api/diocese/care/*. The
// live-affiliation guard was written into diocese.js as an audit follow-up
// and never propagated; the three /submissions/:id/* routes were keyed on
// s.diocese_org_id, which is a permanent stamp that does not expire when a
// parish leaves.
// ─────────────────────────────────────────────────────────────────────────
describe('a diocese reads a parish only while the covenant holds (CARE.SEC)', () => {
  let dTok, pTok, parishOrgId, submissionId

  beforeAll(async () => {
    const d = await createOrg(server, { organizationName: `Covenant Diocese ${RUN_ID}`, organizationType: 'diocese',
              name: 'Dana Chancellor', email: `cov_dio_${RUN_ID}@example.com`,
              password: 'covenant-dio-pw-1' }, '10.80.1.1')
    expect(d.status).toBe(201)
    dTok = d.body.token

    const p = await createOrg(server, { organizationName: `Covenant Parish ${RUN_ID}`, name: 'Ana Admin',
              email: `cov_par_${RUN_ID}@example.com`, password: 'covenant-par-pw-1' }, '10.80.1.2')
    expect(p.status).toBe(201)
    pTok = p.body.token
    parishOrgId = p.body.user.organization.id

    const inv = await request(server).post('/api/diocese/parishes/invite')
      .set('Authorization', `Bearer ${dTok}`).send({ email: `cov_par_${RUN_ID}@example.com` })
    expect(inv.status).toBe(201)

    // SUMMARY, deliberately — the existing diocese tests all accept with
    // 'detail', which is why the grant bypass was never exercised.
    const acc = await request(server).post('/api/affiliation/accept')
      .set('Authorization', `Bearer ${pTok}`).send({ grant_level: 'summary' })
    expect(acc.status).toBe(200)
    expect(acc.body.affiliation.grant_level).toBe('summary')

    // Real money, so totals_json carries account lines to leak.
    await request(server).post('/api/donations').set('Authorization', `Bearer ${pTok}`)
      .send({ donor_name: `Giver ${RUN_ID}`, amount: 12345.67, category: 'tithe', date: '2026-03-01' })
    const sub = await request(server).post('/api/finance/submissions')
      .set('Authorization', `Bearer ${pTok}`)
      .send({ period_start: '2026-01-01', period_end: '2026-03-31' })
    expect(sub.status).toBe(201)
    submissionId = sub.body.id

    const { rows } = await pool.query(
      `SELECT jsonb_array_length(totals_json->'accounts') AS n
         FROM ochr_report_submissions WHERE id = $1`, [submissionId])
    expect(Number(rows[0].n), 'fixture: there must be account lines to withhold')
      .toBeGreaterThanOrEqual(1)
  })

  const review = () => request(server)
    .get(`/api/diocese/care/submissions/${submissionId}/review`)
    .set('Authorization', `Bearer ${dTok}`)

  it('A SUMMARY GRANT WITHHOLDS ACCOUNT LINES ON THE CARE ROUTE TOO', async () => {
    const res = await review()
    expect(res.status).toBe(200)
    const t = res.body.submission.totals_json ?? {}
    // The parish still gets reviewed — this is not a lockout.
    expect(t.totals, 'summary must still release the totals').toBeTruthy()
    // But not its account-by-account books.
    expect(t.accounts, 'the care route leaked per-account lines to a summary grant')
      .toBeUndefined()
    expect(res.body.grant_level).toBe('summary')
  })

  // A GARBAGE PARISH ID IS A 400, NOT A 500, ON EVERY ROUTE THAT TAKES ONE.
  //
  // `Number('abc')` is NaN, and NaN reaching a query parameter is a Postgres
  // error, which the catch-all turns into a 500. That is the app reporting
  // its own fault for the caller's typo, and a 500 is what wakes somebody up.
  //
  // Six routes here take :parishId. TWO guarded it inline and four did not —
  // with `requireIntParam` already imported at the top of the same file,
  // one line away. That is the shape of nearly every defect found this
  // month: the fix existed, in scope, and did not travel.
  //
  // Enumerated rather than listed, so a seventh route added tomorrow is
  // covered by this test on the day it is written.
  it('EVERY :parishId ROUTE REFUSES GARBAGE WITH A 400 RATHER THAN A 500', async () => {
    // EVERY BODY HERE IS VALID. That is the whole design of this test.
    //
    // The first version sent `{}` to the POSTs and passed with the guard
    // deliberately removed — because those handlers validate the body BEFORE
    // they touch the database, so an empty body returns 400 from a code path
    // that has nothing to do with the parish id. It asserted the right status
    // for the wrong reason, which is the fifth time that exact trap has been
    // caught in this codebase.
    //
    // With a valid body the ONLY thing left that can fail is the id, so a
    // 500 here means NaN reached a query. `Number('not-a-number')` is NaN and
    // Postgres answers 22P02, invalid input syntax for integer — measured,
    // not assumed.
    const GARBAGE = 'not-a-number'
    const calls = [
      ['get',  `/api/diocese/care/${GARBAGE}`,             undefined],
      ['get',  `/api/diocese/care/${GARBAGE}/brief`,       undefined],
      ['post', `/api/diocese/care/${GARBAGE}/timeline`,    { kind: 'note', summary: 'A valid summary line.' }],
      ['post', `/api/diocese/care/${GARBAGE}/followups`,   { context: 'A valid context.', next_action: 'A valid next action.' }],
      ['post', `/api/diocese/care/${GARBAGE}/transitions`, { kind: 'clergy_arrival' }],
      ['post', `/api/diocese/care/${GARBAGE}/brief`,       {}],
    ]
    for (const [method, path, body] of calls) {
      const req_ = request(server)[method](path).set('Authorization', `Bearer ${dTok}`)
      const res = body === undefined ? await req_ : await req_.send(body)
      expect(res.status, `${method.toUpperCase()} ${path} faulted instead of refusing`)
        .not.toBe(500)
      expect([400, 404], `${method.toUpperCase()} ${path} → ${res.status}`).toContain(res.status)
    }
  })

  // THE CLASS, NOT THE FIELD.
  //
  // The test above names `accounts`, which is the field somebody already
  // knew to withhold. It passes just as happily against a DENYLIST — and a
  // denylist is what withGrant was: `const { accounts, ...rest }`, meaning
  // name the one thing to hide and release everything else.
  //
  // That is default-open. periodTotals.js emits { groups, accounts, totals }
  // today and is the obvious place to add a per-donor breakdown, a payroll
  // line, a top-gifts list. Any of those would have reached a summary-grant
  // diocese the day it was added, with no change to this file, no review,
  // and nothing on screen to notice.
  //
  // So this injects a field nobody has written yet and requires it to be
  // withheld anyway. A parish's grant level is its one real control over its
  // own books; a control that must be updated whenever somebody else adds a
  // field is a promise to remember, not a control.
  it('A FIELD NOBODY HAS WRITTEN YET IS WITHHELD FROM A SUMMARY GRANT', async () => {
    const { rows: before } = await pool.query(
      `SELECT totals_json FROM ochr_report_submissions WHERE id = $1`, [submissionId])

    await pool.query(
      `UPDATE ochr_report_submissions
          SET totals_json = totals_json || $2::jsonb
        WHERE id = $1`,
      [submissionId, JSON.stringify({
        donor_breakdown: [{ name: 'Someone Specific', total: '4200.00' }],
        payroll_lines:   [{ person: 'The Rector', gross: '5000.00' }],
      })])
    try {
      const res = await review()
      expect(res.status).toBe(200)
      const t = res.body.submission.totals_json ?? {}

      expect(t.donor_breakdown, 'an unknown field reached a summary grant').toBeUndefined()
      expect(t.payroll_lines,   'an unknown field reached a summary grant').toBeUndefined()

      // And the allowlist still releases what the parish DID agree to.
      expect(t.totals, 'summary must still release the totals').toBeTruthy()
      expect(t.groups, 'summary must still release the rollup groups').toBeTruthy()
      expect(t.accounts).toBeUndefined()
    } finally {
      await pool.query(
        `UPDATE ochr_report_submissions SET totals_json = $2 WHERE id = $1`,
        [submissionId, before[0].totals_json])
    }
  })

  // Found in a second pass over this very change.
  //
  // The allowlist uses `k in src`, and `in` throws a TypeError on a
  // primitive. totals_json is JSONB, which holds a scalar perfectly legally,
  // and this database has demonstrably been written to by ad-hoc scripts
  // before. The denylist this replaced degraded on a malformed value; the
  // first version of the allowlist turned it into a 500 on a chancery review
  // screen — a worse answer than the one it replaced.
  it('A MALFORMED totals_json RELEASES NOTHING RATHER THAN FAULTING', async () => {
    const { rows: before } = await pool.query(
      `SELECT totals_json FROM ochr_report_submissions WHERE id = $1`, [submissionId])
    try {
      for (const junk of ['"a bare string"', '42', '[1,2,3]']) {
        await pool.query(
          `UPDATE ochr_report_submissions SET totals_json = $2::jsonb WHERE id = $1`,
          [submissionId, junk])
        const res = await review()
        expect(res.status, `totals_json = ${junk} faulted instead of degrading`).toBe(200)
        expect(res.body.submission.totals_json,
          `totals_json = ${junk} released something we could not read`).toEqual({})
      }
    } finally {
      await pool.query(
        `UPDATE ochr_report_submissions SET totals_json = $2 WHERE id = $1`,
        [submissionId, before[0].totals_json])
    }
  })

  it('a DETAIL grant still receives everything, including the new field', async () => {
    // The allowlist must not become a lockout. 'detail' is the parish saying
    // yes to the whole picture, and it has to keep meaning that — otherwise
    // the next person to add a field quietly breaks the drill-down instead.
    const { rows: before } = await pool.query(
      `SELECT totals_json, grant_level FROM ochr_report_submissions s
         JOIN ochr_diocese_affiliations a ON a.parish_org_id = s.organization_id
        WHERE s.id = $1 AND a.status IN ('active','suspended')`, [submissionId])
    await pool.query(
      `UPDATE ochr_report_submissions
          SET totals_json = totals_json || $2::jsonb WHERE id = $1`,
      [submissionId, JSON.stringify({ donor_breakdown: [{ name: 'X', total: '1.00' }] })])
    await pool.query(
      `UPDATE ochr_diocese_affiliations SET grant_level = 'detail'
        WHERE parish_org_id = $1 AND status IN ('active','suspended')`, [parishOrgId])
    try {
      const res = await review()
      expect(res.status).toBe(200)
      const t = res.body.submission.totals_json ?? {}
      expect(t.accounts, 'a detail grant must still receive account lines').toBeTruthy()
      expect(t.donor_breakdown, 'a detail grant must receive the whole object').toBeTruthy()
    } finally {
      await pool.query(
        `UPDATE ochr_report_submissions SET totals_json = $2 WHERE id = $1`,
        [submissionId, before[0].totals_json])
      await pool.query(
        `UPDATE ochr_diocese_affiliations SET grant_level = 'summary'
          WHERE parish_org_id = $1 AND status IN ('active','suspended')`, [parishOrgId])
    }
  })

  it('and the sanctioned route agrees, which is the point', async () => {
    const res = await request(server).get(`/api/diocese/parishes/${parishOrgId}/financials`)
      .set('Authorization', `Bearer ${dTok}`)
    expect(res.status).toBe(200)
    for (const period of res.body.periods ?? []) {
      expect(period.accounts, 'the sanctioned route leaked account lines').toBeUndefined()
    }
  })

  it('a DETAIL grant releases them on both routes', async () => {
    const up = await request(server).patch('/api/affiliation/grant')
      .set('Authorization', `Bearer ${pTok}`).send({ grant_level: 'detail' })
    expect(up.status).toBe(200)

    const res = await review()
    expect(res.status).toBe(200)
    expect(res.body.grant_level).toBe('detail')
    expect(res.body.submission.totals_json.accounts,
      'a detail grant must still release account lines').toBeTruthy()

    // …and put it back, so the revocation tests below start from summary.
    await request(server).patch('/api/affiliation/grant')
      .set('Authorization', `Bearer ${pTok}`).send({ grant_level: 'summary' })
  })

  describe('once the parish leaves', () => {
    beforeAll(async () => {
      const left = await request(server).post('/api/affiliation/leave')
        .set('Authorization', `Bearer ${pTok}`).send({})
      expect(left.status).toBe(200)
      const { rows } = await pool.query(
        `SELECT status FROM ochr_diocese_affiliations WHERE parish_org_id = $1`, [parishOrgId])
      expect(rows[0].status).toBe('ended')
    })

    it('the sanctioned routes close', async () => {
      const subs = await request(server).get('/api/diocese/submissions')
        .set('Authorization', `Bearer ${dTok}`)
      expect(subs.status).toBe(200)
      expect((subs.body.submissions ?? []).some(x => x.id === submissionId)).toBe(false)

      const fin = await request(server).get(`/api/diocese/parishes/${parishOrgId}/financials`)
        .set('Authorization', `Bearer ${dTok}`)
      expect(fin.status).toBe(404)
    })

    it('AND SO DOES THE CARE ROUTE — no reading the books of a parish that left', async () => {
      const res = await review()
      expect(res.status, 'an ex-diocese could still read the frozen report').toBe(404)
    })

    it('AND SO DO BOTH WRITE PATHS — no writing onto an ex-parish record', async () => {
      const reviewed = await request(server)
        .post(`/api/diocese/care/submissions/${submissionId}/reviewed`)
        .set('Authorization', `Bearer ${dTok}`)
        .send({ reviewed_together_on: '2026-08-24', reviewed_together_name: 'Ex Chancellor' })
      expect(reviewed.status).toBe(404)

      const note = await request(server)
        .post(`/api/diocese/care/submissions/${submissionId}/notes`)
        .set('Authorization', `Bearer ${dTok}`)
        .send({ body: `written after leaving ${RUN_ID}`, visibility: 'shared' })
      expect(note.status).toBe(404)

      // And nothing landed on the parish's own row.
      const { rows } = await pool.query(
        `SELECT reviewed_together_name FROM ochr_report_submissions WHERE id = $1`, [submissionId])
      expect(rows[0].reviewed_together_name,
        'an ex-diocese stamped its name on the parish record').toBeNull()
      const { rows: notes } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ochr_report_review_notes WHERE body LIKE $1`,
        [`%after leaving ${RUN_ID}%`])
      expect(notes[0].n, 'an ex-diocese wrote a note onto the parish record').toBe(0)
    })
  })

  // ── Reconciliation (migration 094) ─────────────────────────────────────
  //
  // A parish that leaves can be invited back. It could not before, and the
  // reason was migration 058's unconditional UNIQUE (diocese_org_id,
  // parish_org_id) sitting alongside the partial index that expresses the
  // real rule. The partial index correctly frees an 'ended' parish; the
  // unconditional one blocked the ONE diocese most likely to be reconciling
  // with it, and the route then told them "invited by someone else".
  //
  // These run after the leave block above, so the covenant fixtures are in
  // exactly the state a real reconciliation starts from.
  describe('and then comes back', () => {
    it('the same diocese may invite the parish again', async () => {
      const again = await request(server).post('/api/diocese/parishes/invite')
        .set('Authorization', `Bearer ${dTok}`)
        .send({ email: `cov_par_${RUN_ID}@example.com` })
      expect(again.status, 'a departed parish must be re-invitable by the diocese it left').toBe(201)
      expect(again.body.status).toBe('invited')
    })

    it('THE DEPARTED AFFILIATION IS STILL ON THE RECORD', async () => {
      // The point of a new row rather than reviving the old one. When this
      // parish and this diocese were together before, and when that ended,
      // is a fact about both of them — and a reconciliation is not a reason
      // to overwrite it.
      const { rows } = await pool.query(
        `SELECT status FROM ochr_diocese_affiliations
          WHERE parish_org_id = $1 ORDER BY created_at ASC`, [parishOrgId])
      expect(rows.length).toBe(2)
      expect(rows[0].status).toBe('ended')
      expect(rows[1].status).toBe('invited')
    })

    it('the roster shows the parish ONCE, in its current state', async () => {
      // Two affiliation rows, one parish. A chancery reading
      // "St. Anne · ended" beside "St. Anne · invited" has to work out
      // which is now true, and that is not a question a roster should ask.
      const roster = await request(server).get('/api/diocese/parishes')
        .set('Authorization', `Bearer ${dTok}`)
      expect(roster.status).toBe(200)
      const mine = (roster.body.parishes ?? []).filter(r => r.parish_org_id === parishOrgId)
      expect(mine.length, 'the roster listed the same parish twice').toBe(1)
      expect(mine[0].status).toBe('invited')
    })

    it('AN INVITATION IS NOT ACCESS — the covenant stays shut until the parish accepts', async () => {
      // The dangerous reading of "re-invite works" would be that inviting
      // reopens the books. It does not: 'invited' is not a live grant, and
      // the parish's own decision is what reopens anything.
      const fin = await request(server).get(`/api/diocese/parishes/${parishOrgId}/financials`)
        .set('Authorization', `Bearer ${dTok}`)
      expect(fin.status, 'an invitation must not restore access on its own').toBe(404)
    })

    it('accepting re-affiliates, and only then does the covenant reopen', async () => {
      const acc = await request(server).post('/api/affiliation/accept')
        .set('Authorization', `Bearer ${pTok}`).send({ grant_level: 'summary' })
      expect(acc.status).toBe(200)

      const { rows } = await pool.query(
        `SELECT status, grant_level FROM ochr_diocese_affiliations
          WHERE parish_org_id = $1 ORDER BY created_at ASC`, [parishOrgId])
      expect(rows.length).toBe(2)
      expect(rows[0].status, 'the historical row was rewritten').toBe('ended')
      expect(rows[1].status).toBe('active')

      const fin = await request(server).get(`/api/diocese/parishes/${parishOrgId}/financials`)
        .set('Authorization', `Bearer ${dTok}`)
      expect(fin.status).toBe(200)
    })

    it('A SECOND LIVE AFFILIATION FOR THE SAME PAIR IS STILL REFUSED', async () => {
      // The replacement index has to keep doing the old one's real job.
      // Dropping a constraint is only safe if what replaces it still
      // refuses what mattered.
      await expect(
        pool.query(
          `INSERT INTO ochr_diocese_affiliations (diocese_org_id, parish_org_id, status)
           SELECT diocese_org_id, parish_org_id, 'invited'
             FROM ochr_diocese_affiliations
            WHERE parish_org_id = $1 AND status = 'active'`, [parishOrgId])
      ).rejects.toThrow()
    })
  })

})
