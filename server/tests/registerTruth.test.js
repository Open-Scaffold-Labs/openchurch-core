// The register says what it says — four places where it did not.
//
// A read-only audit reproduced each of these against the real routes:
//
//   D1  a VOIDED entry kept producing anniversaries (the endpoint and the
//       weekly digest never filtered voided_at; the parochial report did)
//   D2  register search matched the member's CURRENT name, not the name
//       the register recorded — so a renamed member's baptism was found
//       under a name that was never baptised, and an unlinked historic
//       subject could not be found at all
//   D3  a correction could leave an entry naming nobody, and a row with no
//       stored snapshot silently took on whichever member it was relinked to
//   D4  dates were handed to Postgres as free text under DateStyle MDY, so a
//       DD/MM register digitised as "10/05/1953" stored 5 October for a
//       10 May baptism, and "1953" was a 500
//
// Companion to historicalIdentity.test.js (Pass 8), which owns the
// snapshot-vs-live-name rule itself. Same harness, same conventions.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, app, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { enqueueSacramentAnniversaryDigests } from '../src/notifications/sacramentAnniversaries.js'

let server, token, orgId
const auth = (r) => r.set('Authorization', `Bearer ${token}`)

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const signup = await request(server).post('/api/auth/signup')
    .set('X-Forwarded-For', '10.99.77.45')
    .send({
      organizationName: `Register Truth ${RUN_ID}`,
      name: 'Register Truth Admin',
      email: `regtruth_${RUN_ID}@example.com`,
      password: 'smoke-test-pw-883',
    })
  expect(signup.status).toBe(201)
  token = signup.body.token
  const { rows } = await pool.query('SELECT id FROM ochr_organizations WHERE name = $1', [`Register Truth ${RUN_ID}`])
  orgId = rows[0].id
}, 60_000)

afterAll(async () => { await closeServer(server); await pool.end() })

const newMember = async (name) => {
  const res = await auth(request(server).post('/api/clients')).send({ name })
  expect(res.status).toBe(201)
  return res.body.id
}
const newRecord = (body) => auth(request(server).post('/api/sacraments')).send(body)
const readRecord = (id) => auth(request(server).get(`/api/sacraments/${id}`))
const patchRecord = (id, body) => auth(request(server).patch(`/api/sacraments/${id}`)).send(body)
const searchRegister = async (q) => {
  const res = await auth(request(server).get('/api/sacraments').query({ q, limit: 100 }))
  expect(res.status).toBe(200)
  return res.body.records
}
const amendments = async (id) => {
  const res = await auth(request(server).get(`/api/sacraments/${id}/amendments`))
  expect(res.status).toBe(200)
  return res.body.amendments
}

const pad = n => String(n).padStart(2, '0')
// A YYYY-MM-DD `yearsAgo` years back whose month/day lands `daysAhead` days
// after `from`. Feb 29 is nudged to Mar 1: it has no annual anniversary.
function anniversaryDate(daysAhead, yearsAgo, from = new Date()) {
  const t = new Date(from); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() + daysAhead)
  if (t.getMonth() === 1 && t.getDate() === 29) t.setDate(t.getDate() + 1)
  return `${t.getFullYear() - yearsAgo}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

// ── D1 ──────────────────────────────────────────────────────────────────
describe('D1. a voided entry produces no anniversaries', () => {
  it('GET /anniversaries drops the entry on void and brings it back on restore', async () => {
    const memberId = await newMember('Void Anniversary Subject')
    const rec = await newRecord({ client_id: memberId, type: 'baptism', date: anniversaryDate(3, 5) })
    expect(rec.status).toBe(201)

    const listBefore = await auth(request(server).get('/api/sacraments/anniversaries?days=7'))
    expect(listBefore.status).toBe(200)
    expect(listBefore.body.anniversaries.some(a => a.id === rec.body.id)).toBe(true)

    const voided = await auth(request(server).post(`/api/sacraments/${rec.body.id}/void`))
      .send({ reason: 'Entered against the wrong register.' })
    expect(voided.status).toBe(200)

    // A void is a retired entry. A retired entry has no anniversary to
    // congratulate anyone on.
    const listVoided = await auth(request(server).get('/api/sacraments/anniversaries?days=7'))
    expect(listVoided.body.anniversaries.some(a => a.id === rec.body.id)).toBe(false)

    const restored = await auth(request(server).post(`/api/sacraments/${rec.body.id}/restore`))
      .send({ reason: 'Voided in error; the entry stands.' })
    expect(restored.status).toBe(200)

    const listRestored = await auth(request(server).get('/api/sacraments/anniversaries?days=7'))
    expect(listRestored.body.anniversaries.some(a => a.id === rec.body.id)).toBe(true)
  })

  it('the weekly digest never drafts a note for a voided entry', async () => {
    // The digest is idempotent per org per ISO week. smoke.test.js drives it
    // with the real clock in the same database, so this run uses a clock
    // 100 days out: a different ISO week, a different dedup key, and no
    // fight over who enqueued first.
    const now = new Date(); now.setHours(0, 0, 0, 0); now.setDate(now.getDate() + 100)

    const kept = `Digest Kept ${RUN_ID}`
    const gone = `Digest Voided ${RUN_ID}`
    const keptId = await newMember(kept)
    const goneId = await newMember(gone)
    const keptRec = await newRecord({ client_id: keptId, type: 'confirmation', date: anniversaryDate(2, 5, now) })
    const goneRec = await newRecord({ client_id: goneId, type: 'confirmation', date: anniversaryDate(2, 5, now) })
    expect(keptRec.status).toBe(201)
    expect(goneRec.status).toBe(201)
    const voided = await auth(request(server).post(`/api/sacraments/${goneRec.body.id}/void`))
      .send({ reason: 'Duplicate of an earlier entry.' })
    expect(voided.status).toBe(200)

    const result = await enqueueSacramentAnniversaryDigests({ now })
    expect(result.digestsEnqueued).toBeGreaterThanOrEqual(1)

    const { rows } = await pool.query(
      `SELECT vars FROM ochr_scheduled_notifications
        WHERE organization_id = $1 AND notification_type = 'sacrament_anniversary_digest'`,
      [orgId]
    )
    const blocks = rows.map(r => r.vars.items_block)
    expect(blocks.some(b => b.includes(kept))).toBe(true)
    expect(blocks.some(b => b.includes(gone))).toBe(false)
  })
})

// ── D2 ──────────────────────────────────────────────────────────────────
describe('D2. the register is searched by what the register says', () => {
  it('finds an unlinked historic subject by the recorded name', async () => {
    const rec = await newRecord({ member_name: 'Ana Delgado', type: 'baptism', date: '1953-03-14' })
    expect(rec.status).toBe(201)
    // Before the fix the search matched c.name only — NULL for an unlinked
    // entry — so the person a digitisation pass had just typed in could not
    // be found by name at all.
    const hits = await searchRegister('Delgado')
    expect(hits.some(r => r.id === rec.body.id)).toBe(true)
  })

  it('a renamed member\'s baptism is found under the baptised name, not the current one', async () => {
    const memberId = await newMember('Maria Ruiz')
    const rec = await newRecord({ client_id: memberId, type: 'baptism', date: '2019-05-10', certificate_no: 'D2-MR-001' })
    expect(rec.body.member_name).toBe('Maria Ruiz')

    const rename = await auth(request(server).patch(`/api/clients/${memberId}`)).send({ name: 'Maria Ruiz Garcia' })
    expect(rename.status).toBe(200)

    const byOld = await searchRegister('Ruiz')
    const hit = byOld.find(r => r.id === rec.body.id)
    expect(hit).toBeTruthy()
    expect(hit.member_name).toBe('Maria Ruiz')

    // The register recorded "Maria Ruiz". Nobody named "Maria Ruiz Garcia"
    // was baptised in 2019, so a search for that name must not surface this
    // entry: the list DISPLAYS the snapshot (Pass 8), and a search that
    // matched on the live name would return rows whose shown name does not
    // contain the query. Finding the member by her current name is the
    // roster's job — the link is still on the record for that.
    const byLive = await searchRegister('Ruiz Garcia')
    expect(byLive.some(r => r.id === rec.body.id)).toBe(false)
  })
})

// ── D3 ──────────────────────────────────────────────────────────────────
describe('D3. an entry always names its subject', () => {
  // A pre-054 row: linked, but with no stored snapshot. Nothing in the API
  // can create one any more, so it is made the way the backfill found them.
  const nullSnapshotRecord = async (clientId) => {
    const rec = await newRecord({ client_id: clientId, type: 'baptism', date: '1990-01-01' })
    expect(rec.status).toBe(201)
    await pool.query('UPDATE ochr_sacramental_records SET member_name = NULL WHERE id = $1 AND organization_id = $2',
      [rec.body.id, orgId])
    return rec.body.id
  }

  describe('(a) a correction may not blank the name, linked or not', () => {
    it.each([
      ['empty string', ''],
      ['whitespace', '   '],
      ['null', null],
    ])('refuses member_name = %s on a LINKED record', async (_label, blank) => {
      const memberId = await newMember('Linked Blank Target')
      const rec = await newRecord({ client_id: memberId, type: 'baptism', date: '1980-01-01' })
      // Previously allowed "because the link can still answer who this is".
      // It cannot: the link is a relationship to a present-day roster row,
      // and the roster row can be renamed, merged or deleted. The entry
      // itself has to say who was baptised.
      const res = await patchRecord(rec.body.id, { member_name: blank, reason: 'attempting to blank the subject' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/must name its subject/i)
      const read = await readRecord(rec.body.id)
      expect(read.body.member_name).toBe('Linked Blank Target')
    })

    it('refuses member_name = "" on an UNLINKED record (unchanged)', async () => {
      const rec = await newRecord({ member_name: 'Unlinked Blank Target', type: 'baptism', date: '1970-01-01' })
      const res = await patchRecord(rec.body.id, { member_name: '', reason: 'attempting to blank the subject' })
      expect(res.status).toBe(400)
    })
  })

  describe('(b) a NULL-snapshot row keeps the identity it has been showing', () => {
    it('relink stamps the CURRENT member\'s name first and the history shows it', async () => {
      const oldId = await newMember('Snapshotless Original')
      const newId = await newMember('Snapshotless Newcomer')
      const recId = await nullSnapshotRecord(oldId)

      const shown = await readRecord(recId)
      expect(shown.body.member_name).toBe('Snapshotless Original')   // via the COALESCE fallback

      const res = await patchRecord(recId, { client_id: newId, reason: 'Matched to the right member.' })
      expect(res.status).toBe(200)
      // The relink must not redefine who was baptised.
      expect(res.body.client_id).toBe(newId)
      expect(res.body.member_name).toBe('Snapshotless Original')

      const hist = await amendments(recId)
      const last = hist.at(-1)
      expect(last.kind).toBe('correction')
      expect(last.before_json.member_name).toBe('Snapshotless Original')
      expect(last.after_json.member_name).toBe('Snapshotless Original')
      expect(last.after_json.client_id).toBe(newId)
    })

    it('unlink stamps the name before the link goes away', async () => {
      const oldId = await newMember('Snapshotless Unlinked')
      const recId = await nullSnapshotRecord(oldId)
      const res = await patchRecord(recId, { client_id: null, reason: 'Wrong member matched.' })
      expect(res.status).toBe(200)
      expect(res.body.client_id).toBeNull()
      expect(res.body.member_name).toBe('Snapshotless Unlinked')
    })

    it('a true orphan (no snapshot, no link) cannot be relinked without a name', async () => {
      const oldId = await newMember('Orphan Origin')
      const recId = await nullSnapshotRecord(oldId)
      await pool.query('UPDATE ochr_sacramental_records SET client_id = NULL WHERE id = $1 AND organization_id = $2', [recId, orgId])

      const target = await newMember('Orphan Claimant')
      // Letting the relink define the identity would write a null→null
      // trail into the history and let the member row decide who was
      // baptised. The caller has to say who the register names.
      const bare = await patchRecord(recId, { client_id: target, reason: 'Guessing the member.' })
      expect(bare.status).toBe(400)
      expect(bare.body.error).toMatch(/must name its subject/i)

      const named = await patchRecord(recId, { client_id: target, member_name: 'Orphan Origin', reason: 'Name read from the register page.' })
      expect(named.status).toBe(200)
      expect(named.body.member_name).toBe('Orphan Origin')
      expect(named.body.client_id).toBe(target)
    })

    it('a row that already has a snapshot is NOT re-stamped on relink (Pass 8)', async () => {
      const rec = await newRecord({ member_name: 'Snapshot Holder', type: 'confirmation', date: '1961-06-01' })
      const memberId = await newMember('Snapshot Holder Today')
      const res = await patchRecord(rec.body.id, { client_id: memberId, reason: 'Matched to her member record.' })
      expect(res.status).toBe(200)
      expect(res.body.member_name).toBe('Snapshot Holder')
      const hist = await amendments(rec.body.id)
      expect(hist.at(-1).before_json.member_name).toBe('Snapshot Holder')
    })
  })

  describe('(c) creation', () => {
    it('an unlinked POST without member_name is refused', async () => {
      const res = await newRecord({ type: 'baptism', date: '1960-01-01' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/must name its subject/i)
    })

    it('an unlinked POST with a whitespace member_name is refused', async () => {
      const res = await newRecord({ member_name: '  ', type: 'baptism', date: '1960-01-01' })
      expect(res.status).toBe(400)
    })
  })

  it('deleting the member leaves the entry naming the person', async () => {
    const memberId = await newMember('Departed Parishioner')
    const rec = await newRecord({ client_id: memberId, type: 'baptism', date: '1985-04-04' })
    expect(rec.status).toBe(201)
    const del = await auth(request(server).delete(`/api/clients/${memberId}`))
    expect(del.status).toBe(204)
    const read = await readRecord(rec.body.id)
    expect(read.status).toBe(200)
    expect(read.body.client_id).toBeNull()
    expect(read.body.member_name).toBe('Departed Parishioner')
  })
})

// ── D4 ──────────────────────────────────────────────────────────────────
describe('D4. register dates are strict YYYY-MM-DD', () => {
  it('POST refuses "10/05/1953" with the accepted format in the message', async () => {
    // Under DateStyle MDY Postgres reads this as 5 October. A DD/MM paper
    // register digitised this way moves every baptism to the wrong month
    // without a single error.
    const res = await newRecord({ member_name: 'Date Format Subject', type: 'baptism', date: '10/05/1953' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/YYYY-MM-DD/)
  })

  it('POST refuses a bare year with 400, not 500', async () => {
    const res = await newRecord({ member_name: 'Year Only Subject', type: 'baptism', date: '1953' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/YYYY-MM-DD/)
  })

  it('POST refuses a well-formed date that does not exist', async () => {
    const res = await newRecord({ member_name: 'Impossible Date Subject', type: 'baptism', date: '1953-02-30' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/YYYY-MM-DD/)
  })

  it('POST stores "1953-10-05" exactly', async () => {
    const res = await newRecord({ member_name: 'ISO Date Subject', type: 'baptism', date: '1953-10-05' })
    expect(res.status).toBe(201)
    expect(res.body.date).toBe('1953-10-05')
    const read = await readRecord(res.body.id)
    expect(read.body.date).toBe('1953-10-05')
  })

  it('a draft may HOLD "10/05/1953" but cannot COMMIT it, and no record is written', async () => {
    // Drafts are the transcription of the paper page; the raw text belongs
    // there. The register does not accept it until someone has read it.
    const staged = await auth(request(server).post('/api/sacraments/drafts')).send({
      drafts: [{ source: 'csv', draft: {
        member_name: 'Draft Date Subject', type: 'baptism', date: '10/05/1953', certificate_no: 'D4-DRAFT-001',
      } }],
    })
    expect(staged.status).toBe(201)
    const draftId = staged.body.drafts[0].id

    const committed = await auth(request(server).post(`/api/sacraments/drafts/${draftId}/commit`)).send({})
    expect(committed.status).toBe(400)
    expect(committed.body.error).toMatch(/YYYY-MM-DD/)

    const drafts = await auth(request(server).get('/api/sacraments/drafts?status=pending&limit=200'))
    const still = drafts.body.drafts.find(d => d.id === draftId)
    expect(still).toBeTruthy()
    expect(still.committed_record_id).toBeNull()

    const hits = await searchRegister('D4-DRAFT-001')
    expect(hits.length).toBe(0)
  })

  it('a draft with "1953-10-05" commits and stores exactly that', async () => {
    const staged = await auth(request(server).post('/api/sacraments/drafts')).send({
      drafts: [{ source: 'csv', draft: { member_name: 'Draft ISO Subject', type: 'baptism', date: '1953-10-05' } }],
    })
    const draftId = staged.body.drafts[0].id
    const committed = await auth(request(server).post(`/api/sacraments/drafts/${draftId}/commit`)).send({})
    expect(committed.status).toBe(201)
    expect(committed.body.record.date).toBe('1953-10-05')
  })

  it('PATCH refuses "10/05/1953" the same way', async () => {
    const rec = await newRecord({ member_name: 'Patched Date Subject', type: 'baptism', date: '1953-10-05' })
    const res = await patchRecord(rec.body.id, { date: '10/05/1953', reason: 'Correcting the date.' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/YYYY-MM-DD/)
    const read = await readRecord(rec.body.id)
    expect(read.body.date).toBe('1953-10-05')
  })
})
