// GIV-09 — an issued giving statement is a historical claim.
//
// WHAT WAS BROKEN. The year-end statement a parish hands a donor for their
// taxes had no persistence at all: GET /api/giving-statements/donor re-derived
// every figure from ochr_donation_live (a VIEW computing amount - refunded_total
// at read time) and read the letterhead — name, address, TAX ID, signatory —
// live from ochr_organizations. A statement issued in January silently became a
// different tax claim when a refund posted in March, or when the parish
// corrected its own address.
//
// WHAT THESE PIN. Not "the code has a snapshot column" — that a statement
// issued BEFORE a mutation still reports what it claimed AFTER it, while the
// preview correctly moves. The preview and the issued artifact are asserted in
// the same test, from the same parish, across the same mutation, so a change
// that quietly made both live (or both frozen) cannot pass.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import app from '../src/app.js'

let server
beforeAll(async () => {
  await migrateOnce()
  server = await bindServer(app)
}, 120000)
afterAll(async () => { await closeServer(server) })

const signup = async (body) => {
  const res = await request(app).post('/api/auth/signup')
    .set('X-Forwarded-For', `10.97.${1 + Math.floor(Math.random() * 200)}.5`)
    .send({ password: 'giv09-pw-1', name: 'Admin', ...body })
  expect(res.status).toBe(201)
  return res.body
}

// One parish, one donor, two gifts, letterhead filled in. Returns everything
// a test needs to mutate live truth underneath an issued claim.
async function parish(tag) {
  const org = await signup({
    organizationName: `GIV09 ${tag} ${RUN_ID}`,
    email: `giv09_${tag}_${RUN_ID}@example.com`,
  })
  const tok = org.token
  const auth = r => r.set('Authorization', `Bearer ${tok}`)

  await auth(request(app).patch('/api/organization')).send({
    tax_id: '11-1111111', address: '1 Old Address',
    signatory_name: 'Fr. Alvarez', signatory_title: 'Pastor',
    statement_letterhead: 'ORIGINAL LETTERHEAD',
  })

  const donorEmail = `rosa_${tag}_${RUN_ID}@example.com`
  const g1 = await auth(request(app).post('/api/donations'))
    .send({ donor_name: 'Rosa Vega', donor_email: donorEmail, amount: 500, date: '2026-03-01' })
  const g2 = await auth(request(app).post('/api/donations'))
    .send({ donor_name: 'Rosa Vega', donor_email: donorEmail, amount: 250, date: '2026-06-01' })
  const giftId = g1.body.donation?.id ?? g1.body.id
  expect(giftId).toBeTruthy()
  expect(g2.status).toBeLessThan(300)

  // Provider-shaped so the real refund route accepts it.
  await pool.query(
    `UPDATE ochr_donations SET source='online', payment_ref=$1, payment_status='succeeded' WHERE id=$2`,
    [`pi_giv09_${tag}_${RUN_ID}`, giftId]
  )

  const preview = () => auth(request(app).get('/api/giving-statements/donor')
    .query({ key: donorEmail, year: 2026, by: 'email' }))
  const issue = (issueKey) => auth(request(app).post('/api/giving-statements/issue'))
    .send({ year: 2026, key: donorEmail, by: 'email', issue_key: issueKey })
  const read = (id) => auth(request(app).get(`/api/giving-statements/issued/${id}`))

  return { org, tok, auth, donorEmail, giftId, preview, issue, read }
}

describe('an issued statement is historical truth (GIV-09)', () => {
  it('A NEW ISSUANCE IS SNAPSHOT VERSION 2 IN THE COLUMN AND THE JSON', async () => {
    // Version 1 rows stay as they were written. This only pins what a
    // statement issued now records. No UPDATE of an existing row.
    const p = await parish('version')
    const issued = await p.issue(`ik-version-${RUN_ID}`)
    expect(issued.status).toBe(201)
    const id = issued.body.statement.id
    expect(issued.body.statement.snapshot_version).toBe(2)
    expect(issued.body.statement.snapshot_json.snapshot_version).toBe(2)

    const got = await p.read(id)
    expect(got.status).toBe(200)
    expect(got.body.statement.snapshot_version).toBe(2)
    expect(got.body.statement.snapshot_json.snapshot_version).toBe(2)

    const stored = await pool.query(
      `SELECT snapshot_version, snapshot_json->>'snapshot_version' AS json_version
         FROM ochr_giving_statements WHERE id = $1`,
      [id]
    )
    expect(stored.rows[0].snapshot_version).toBe(2)
    expect(stored.rows[0].json_version).toBe('2')
  })

  it('A REFUND POSTED LATER DOES NOT CHANGE WHAT WAS ISSUED', async () => {
    const p = await parish('refund')

    const before = await p.preview()
    expect(before.status).toBe(200)
    expect(Number(before.body.total)).toBe(750)

    const issued = await p.issue(`ik-refund-${RUN_ID}`)
    expect(issued.status).toBe(201)
    const id = issued.body.statement.id
    expect(issued.body.statement.snapshot_json.total).toBe('750.00')

    // The real refund route, not a hand-written fact.
    const refund = await p.auth(request(app).post(`/api/donations/${p.giftId}/refund`)).send({ amount: 500 })
    expect(refund.status).toBe(200)

    // Preview MUST move — it is live truth and that is correct.
    const after = await p.preview()
    expect(Number(after.body.total)).toBe(250)

    // The issued claim MUST NOT move.
    const got = await p.read(id)
    expect(got.status).toBe(200)
    expect(got.body.statement.snapshot_json.total).toBe('750.00')
    expect(got.body.statement.snapshot_json.lines.map(l => l.refunded_total)).toEqual(['0.00', '0.00'])
  })

  it('A LETTERHEAD CHANGED LATER DOES NOT CHANGE WHAT WAS ISSUED', async () => {
    const p = await parish('letterhead')
    const issued = await p.issue(`ik-letter-${RUN_ID}`)
    expect(issued.status).toBe(201)
    const id = issued.body.statement.id

    await p.auth(request(app).patch('/api/organization')).send({
      tax_id: '99-9999999', address: '2 New Address', statement_letterhead: 'CHANGED LETTERHEAD',
    })

    const after = await p.preview()
    expect(after.body.organization.tax_id).toBe('99-9999999')

    const got = await p.read(id)
    const org = got.body.statement.snapshot_json.organization
    expect(org.tax_id).toBe('11-1111111')
    expect(org.address).toBe('1 Old Address')
    expect(org.statement_letterhead).toBe('ORIGINAL LETTERHEAD')
  })

  it('retrying the same issuance replays the same claim — no duplicate history', async () => {
    const p = await parish('retry')
    const key = `ik-retry-${RUN_ID}`
    const first = await p.issue(key)
    expect(first.status).toBe(201)
    expect(first.body.replayed).toBe(false)

    const second = await p.issue(key)
    expect(second.status).toBe(200)
    expect(second.body.replayed).toBe(true)
    expect(second.body.statement.id).toBe(first.body.statement.id)

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_giving_statements WHERE organization_id = $1`,
      [p.org.user.organization.id]
    )
    expect(rows[0].n).toBe(1)
  })

  it('CONCURRENT RETRIES REPLAY — a double-click never reports failure for a claim that exists', async () => {
    // The pre-flight replay SELECT cannot close this window: both requests see
    // no row and both insert. The unique index rejects one. That rejection must
    // read as a replay, because the statement IS in the register — telling the
    // parish it failed would be a false negative about their own tax document.
    const p = await parish('race')
    const key = `ik-race-${RUN_ID}`
    const fire = () => p.issue(key)
    const results = await Promise.all([fire(), fire(), fire()])

    for (const r of results) expect([200, 201]).toContain(r.status)
    expect(results.filter(r => r.status === 201)).toHaveLength(1)

    const ids = new Set(results.map(r => r.body.statement.id))
    expect(ids.size).toBe(1)

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_giving_statements WHERE organization_id = $1 AND issue_key = $2`,
      [p.org.user.organization.id, key]
    )
    expect(rows[0].n).toBe(1)
  })

  it('a distinct intentional reissue IS representable — the donor lost the first copy', async () => {
    const p = await parish('reissue')
    const a = await p.issue(`ik-a-${RUN_ID}`)
    const b = await p.issue(`ik-b-${RUN_ID}`)
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(b.body.statement.id).not.toBe(a.body.statement.id)
    expect(b.body.statement.statement_no).not.toBe(a.body.statement.statement_no)
  })

  it('UNKNOWN AT ISSUE STAYS UNKNOWN — a blank tax id is not backfilled from today', async () => {
    const org = await signup({
      organizationName: `GIV09 unknown ${RUN_ID}`,
      email: `giv09_unknown_${RUN_ID}@example.com`,
    })
    const auth = r => r.set('Authorization', `Bearer ${org.token}`)
    const donorEmail = `unk_${RUN_ID}@example.com`
    await auth(request(app).post('/api/donations'))
      .send({ donor_name: 'Unknown Donor', donor_email: donorEmail, amount: 100, date: '2026-04-01' })

    // Issued while the parish had NOT filled in Settings → Org details.
    const issued = await auth(request(app).post('/api/giving-statements/issue'))
      .send({ year: 2026, key: donorEmail, by: 'email', issue_key: `ik-unk-${RUN_ID}` })
    expect(issued.status).toBe(201)
    const id = issued.body.statement.id
    expect(issued.body.statement.snapshot_json.unknown_at_issue).toContain('organization.tax_id')

    // The parish fills it in afterwards.
    await auth(request(app).patch('/api/organization')).send({ tax_id: '55-5555555' })

    const got = await auth(request(app).get(`/api/giving-statements/issued/${id}`))
    expect(got.body.statement.snapshot_json.organization.tax_id).toBeNull()
    expect(got.body.statement.snapshot_json.unknown_at_issue).toContain('organization.tax_id')
  })
})

describe('correction is a linked successor, never an edit (GIV-09)', () => {
  it('superseding preserves the original claim and links the new one', async () => {
    const p = await parish('supersede')
    const first = await p.issue(`ik-sup-a-${RUN_ID}`)
    const id = first.body.statement.id

    await p.auth(request(app).post(`/api/donations/${p.giftId}/refund`)).send({ amount: 500 })

    const sup = await p.auth(request(app).post(`/api/giving-statements/issued/${id}/supersede`))
      .send({ issue_key: `ik-sup-b-${RUN_ID}` })
    expect(sup.status).toBe(201)
    // The successor freezes TODAY's truth — the refund is in it.
    expect(sup.body.statement.snapshot_json.total).toBe('250.00')

    const orig = await p.read(id)
    expect(orig.body.statement.status).toBe('superseded')
    expect(orig.body.statement.snapshot_json.total).toBe('750.00')   // untouched
    expect(Number(orig.body.statement.superseded_by_id)).toBe(Number(sup.body.statement.id))

    const again = await p.auth(request(app).post(`/api/giving-statements/issued/${id}/supersede`))
      .send({ issue_key: `ik-sup-c-${RUN_ID}` })
    expect(again.status).toBe(409)
  })

  it('deleting the issuing user keeps the historical attribution (F2, by design)', async () => {
    // issued_by is an operational pointer; issued_by_name is history. The split
    // is deliberate: freezing issued_by would make the trigger fire on the FK's
    // own SET NULL and block deleting any user who ever issued a statement.
    // Both halves are pinned here so a future reviewer does not "correct" one
    // into breaking the other.
    const p = await parish('attrib')
    const issued = await p.issue(`ik-attrib-${RUN_ID}`)
    const id = issued.body.statement.id

    const before = await pool.query(
      `SELECT issued_by, issued_by_name FROM ochr_giving_statements WHERE id = $1`, [id])
    expect(before.rows[0].issued_by).not.toBeNull()
    expect(before.rows[0].issued_by_name).toBeTruthy()

    // Deleting the user must SUCCEED — the freeze trigger must not block it.
    await expect(
      pool.query(`DELETE FROM ochr_users WHERE id = $1`, [before.rows[0].issued_by])
    ).resolves.toBeTruthy()

    const after = await pool.query(
      `SELECT issued_by, issued_by_name, snapshot_json FROM ochr_giving_statements WHERE id = $1`, [id])
    expect(after.rows[0].issued_by).toBeNull()                       // pointer released
    expect(after.rows[0].issued_by_name).toBe(before.rows[0].issued_by_name)  // history kept
    expect(after.rows[0].snapshot_json.total).toBe('750.00')         // claim untouched

    // And the frozen name still cannot be rewritten by hand.
    await expect(
      pool.query(`UPDATE ochr_giving_statements SET issued_by_name = 'Someone Else' WHERE id = $1`, [id])
    ).rejects.toThrow(/historical truth and cannot be rewritten/)
  })

  it('CONCURRENT SUPERSEDE RETRIES REPLAY — the loser is not told its own correction failed', async () => {
    // Both retries serialize on the FOR UPDATE. The second wakes to
    // status='superseded' — set by the first, carrying the SAME key. Answering
    // 409 there tells the parish their correction failed while the correction
    // they asked for is in the register. The key has to be consulted first.
    const p = await parish('sup-race')
    const first = await p.issue(`ik-supr-a-${RUN_ID}`)
    const id = first.body.statement.id
    const key = `ik-supr-race-${RUN_ID}`

    const fire = () => p.auth(request(app).post(`/api/giving-statements/issued/${id}/supersede`))
      .send({ issue_key: key })
    const [a, b] = await Promise.all([fire(), fire()])

    for (const r of [a, b]) expect([200, 201]).toContain(r.status)
    expect([a, b].filter(r => r.status === 201)).toHaveLength(1)
    // Both hands must hold the same correction.
    expect(Number(a.body.statement.id)).toBe(Number(b.body.statement.id))

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_giving_statements WHERE organization_id = $1 AND issue_key = $2`,
      [p.org.user.organization.id, key]
    )
    expect(rows[0].n).toBe(1)
  })

  it('a DIFFERENT key correcting an already-corrected statement is still refused', async () => {
    // The replay-first ordering must not become "anything goes". A genuine
    // second correction of a statement already superseded stays 409.
    const p = await parish('sup-second')
    const first = await p.issue(`ik-sup2-a-${RUN_ID}`)
    const id = first.body.statement.id

    const one = await p.auth(request(app).post(`/api/giving-statements/issued/${id}/supersede`))
      .send({ issue_key: `ik-sup2-b-${RUN_ID}` })
    expect(one.status).toBe(201)

    const two = await p.auth(request(app).post(`/api/giving-statements/issued/${id}/supersede`))
      .send({ issue_key: `ik-sup2-c-${RUN_ID}` })
    expect(two.status).toBe(409)
    expect(two.body.error).toMatch(/already superseded/i)
  })

  it('AN ORDINARY CORRECTION CARRIES LIVE IDENTITY — the frozen block is the deleted-source fallback only', async () => {
    // F1 was approved narrowly. If the frozen identity is used for every
    // supersede, a donor who moved gets a corrected statement addressed to
    // where they used to live, and ordinary correction semantics have changed
    // without anyone deciding to change them.
    const p = await parish('ident')
    const first = await p.issue(`ik-ident-a-${RUN_ID}`)
    const originalDonor = first.body.statement.snapshot_json.donor

    // The donor moved; the parish records the newer gift under the new details.
    await p.auth(request(app).post('/api/donations')).send({
      donor_name: 'Rosa Vega-Marin', donor_email: p.donorEmail,
      donor_address: '2 New Avenue', amount: 40, date: '2026-09-01',
    })

    const sup = await p.auth(request(app).post(`/api/giving-statements/issued/${first.body.statement.id}/supersede`))
      .send({ issue_key: `ik-ident-b-${RUN_ID}` })
    expect(sup.status).toBe(201)

    const snap = sup.body.statement.snapshot_json
    expect(snap.lines.length).toBeGreaterThan(0)
    expect(snap.correction.donor_identity_from).toBe('live-rows')
    expect(snap.donor.name).toBe('Rosa Vega-Marin')
    expect(snap.donor.address).toBe('2 New Avenue')
    expect(snap.donor).not.toEqual(originalDonor)

    // And the original still says what it said.
    const orig = await p.read(first.body.statement.id)
    expect(orig.body.statement.snapshot_json.donor).toEqual(originalDonor)
  })

  it('THE DATABASE REFUSES A REWRITE, not merely the route', async () => {
    const p = await parish('frozen')
    const issued = await p.issue(`ik-frozen-${RUN_ID}`)
    const id = issued.body.statement.id

    await expect(
      pool.query(`UPDATE ochr_giving_statements SET snapshot_json = '{"total":"0.00"}'::jsonb WHERE id = $1`, [id])
    ).rejects.toThrow(/historical truth and cannot be rewritten/)

    await expect(
      pool.query(`DELETE FROM ochr_giving_statements WHERE id = $1`, [id])
    ).rejects.toThrow(/cannot be deleted/)
  })
})

describe('a correction after the source gifts were deleted (GIV-09 F1)', () => {
  // Founder decision, 13 Sep. A parish that issued a statement and then deleted
  // the gifts behind it must still be able to withdraw what it sent. The only
  // honest form of that withdrawal is an explicit zero — and an explicit zero is
  // a CLAIM, not an absence of knowledge, which is why it needed a founder to
  // approve it rather than an engineer to infer it.
  //
  // The narrowness is the point, so it is pinned from both sides: the
  // correction path may issue zero, and the ordinary path still may not.

  it('FIRST-TIME ISSUANCE WITH NOTHING TO CLAIM IS STILL REFUSED', async () => {
    const org = await signup({
      organizationName: `GIV09 F1 empty ${RUN_ID}`,
      email: `giv09_f1empty_${RUN_ID}@example.com`,
    })
    const auth = r => r.set('Authorization', `Bearer ${org.token}`)
    const res = await auth(request(app).post('/api/giving-statements/issue'))
      .send({ year: 2026, key: `nobody_${RUN_ID}@example.com`, by: 'email', issue_key: `ik-f1-empty-${RUN_ID}` })
    expect(res.status).toBe(404)

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_giving_statements WHERE organization_id = $1`,
      [org.user.organization.id]
    )
    expect(rows[0].n).toBe(0)
  })

  it('A DELETED-SOURCE CORRECTION ISSUES AN EXPLICIT ZERO AND KEEPS THE ORIGINAL', async () => {
    const p = await parish('f1')
    const first = await p.issue(`ik-f1-a-${RUN_ID}`)
    expect(first.status).toBe(201)
    const id = first.body.statement.id
    expect(first.body.statement.snapshot_json.total).toBe('750.00')
    const originalDonor = first.body.statement.snapshot_json.donor

    // Every gift behind the claim is deleted — not refunded. There is now no
    // live row anywhere that names this donor for this year.
    await pool.query(
      `DELETE FROM ochr_donations WHERE organization_id = $1 AND lower(donor_email) = lower($2)`,
      [p.org.user.organization.id, p.donorEmail]
    )
    const gone = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_donations WHERE organization_id = $1 AND lower(donor_email) = lower($2)`,
      [p.org.user.organization.id, p.donorEmail]
    )
    expect(gone.rows[0].n).toBe(0)

    const sup = await p.auth(request(app).post(`/api/giving-statements/issued/${id}/supersede`))
      .send({ issue_key: `ik-f1-b-${RUN_ID}` })
    expect(sup.status).toBe(201)

    const snap = sup.body.statement.snapshot_json
    expect(snap.total).toBe('0.00')
    expect(snap.lines).toEqual([])
    expect(snap.gift_count).toBe(0)

    // Identity came from the ORIGINAL frozen claim, not from absence.
    expect(snap.donor).toEqual(originalDonor)
    expect(snap.correction.donor_identity_from).toBe('superseded-statement')
    expect(Number(snap.correction.supersedes_statement_id)).toBe(Number(id))

    // The zero is marked as deliberate. UNKNOWN and ZERO are different answers.
    expect(snap.correction.zero_is_a_claim).toBe(true)
    expect(snap.unknown_at_issue).not.toContain('total')

    // The original survives, untouched, and names its successor.
    const orig = await p.read(id)
    expect(orig.body.statement.status).toBe('superseded')
    expect(orig.body.statement.snapshot_json.total).toBe('750.00')
    expect(orig.body.statement.snapshot_json.donor).toEqual(originalDonor)
    expect(Number(orig.body.statement.superseded_by_id)).toBe(Number(sup.body.statement.id))
  })

  it('a correction that still HAS gifts is not marked as a zero claim', async () => {
    // The zero flag must mean what it says, so the ordinary correction path is
    // asserted alongside it rather than assumed different.
    const p = await parish('f1-nonzero')
    const first = await p.issue(`ik-f1-c-${RUN_ID}`)
    const sup = await p.auth(request(app).post(`/api/giving-statements/issued/${first.body.statement.id}/supersede`))
      .send({ issue_key: `ik-f1-d-${RUN_ID}` })
    expect(sup.status).toBe(201)
    expect(sup.body.statement.snapshot_json.total).toBe('750.00')
    expect(sup.body.statement.snapshot_json.correction.zero_is_a_claim).toBe(false)
    expect(sup.body.statement.snapshot_json.lines).toHaveLength(2)
  })

  it('the zero correction is still frozen — the database refuses to rewrite it', async () => {
    const p = await parish('f1-frozen')
    const first = await p.issue(`ik-f1-e-${RUN_ID}`)
    await pool.query(
      `DELETE FROM ochr_donations WHERE organization_id = $1 AND lower(donor_email) = lower($2)`,
      [p.org.user.organization.id, p.donorEmail]
    )
    const sup = await p.auth(request(app).post(`/api/giving-statements/issued/${first.body.statement.id}/supersede`))
      .send({ issue_key: `ik-f1-f-${RUN_ID}` })
    expect(sup.status).toBe(201)

    await expect(
      pool.query(`UPDATE ochr_giving_statements SET snapshot_json = '{"total":"750.00"}'::jsonb WHERE id = $1`,
        [sup.body.statement.id])
    ).rejects.toThrow(/historical truth and cannot be rewritten/)
  })
})

describe('a key replays its own operation and nothing else (GIV-09)', () => {
  // An issue_key is unique per parish, so a lookup by key alone ALWAYS finds a
  // row — but "a row exists with this key" is a different question from "this
  // is the operation you are retrying", and answering the first one answers the
  // second wrongly. Measured before the fix: superseding statement B with a key
  // already spent on statement A returned 200 replayed, handed back A — another
  // donor, another total — and left B uncorrected. The parish is told its
  // correction succeeded and shown somebody else's tax statement.

  // Two unrelated donors in one parish, and one key that belongs to the first.
  async function twoDonors(tag) {
    const org = await signup({
      organizationName: `GIV09 key ${tag} ${RUN_ID}`,
      email: `giv09_key_${tag}_${RUN_ID}@example.com`,
    })
    const auth = r => r.set('Authorization', `Bearer ${org.token}`)
    const alpha = `alpha_${tag}_${RUN_ID}@example.com`
    const beta  = `beta_${tag}_${RUN_ID}@example.com`
    await auth(request(app).post('/api/donations'))
      .send({ donor_name: 'Alpha Donor', donor_email: alpha, amount: 111, date: '2026-04-01' })
    await auth(request(app).post('/api/donations'))
      .send({ donor_name: 'Beta Donor', donor_email: beta, amount: 222, date: '2026-04-02' })

    const shared = `ik-shared-${tag}-${RUN_ID}`
    const stA = await auth(request(app).post('/api/giving-statements/issue'))
      .send({ year: 2026, key: alpha, by: 'email', issue_key: shared })
    expect(stA.status).toBe(201)
    const stB = await auth(request(app).post('/api/giving-statements/issue'))
      .send({ year: 2026, key: beta, by: 'email', issue_key: `ik-beta-${tag}-${RUN_ID}` })
    expect(stB.status).toBe(201)
    return { org, auth, alpha, beta, shared, stA, stB }
  }

  it('UNRELATED KEY REUSE ON SUPERSEDE IS A CONFLICT, NEVER ANOTHER DONOR\'S CLAIM', async () => {
    const t = await twoDonors('sup')
    const res = await t.auth(request(app).post(`/api/giving-statements/issued/${t.stB.body.statement.id}/supersede`))
      .send({ issue_key: t.shared })

    expect(res.status).toBe(409)
    // The decisive assertion: whatever happens, Alpha's claim must not come back.
    expect(res.body.statement).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toMatch(/Alpha Donor/)
    expect(JSON.stringify(res.body)).not.toMatch(/111\.00/)

    // And B is untouched — not silently corrected, not silently anything.
    const b = await t.auth(request(app).get(`/api/giving-statements/issued/${t.stB.body.statement.id}`))
    expect(b.body.statement.status).toBe('issued')
    expect(b.body.statement.superseded_by_id).toBeNull()
    expect(b.body.statement.snapshot_json.total).toBe('222.00')
  })

  it('UNRELATED KEY REUSE ON ISSUE IS A CONFLICT TOO', async () => {
    const t = await twoDonors('iss')
    const res = await t.auth(request(app).post('/api/giving-statements/issue'))
      .send({ year: 2026, key: t.beta, by: 'email', issue_key: t.shared })

    expect(res.status).toBe(409)
    expect(res.body.statement).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toMatch(/Alpha Donor/)
  })

  it('the same key for the same donor in a DIFFERENT year is also a conflict', async () => {
    const t = await twoDonors('year')
    await t.auth(request(app).post('/api/donations'))
      .send({ donor_name: 'Alpha Donor', donor_email: t.alpha, amount: 55, date: '2025-04-01' })
    const res = await t.auth(request(app).post('/api/giving-statements/issue'))
      .send({ year: 2025, key: t.alpha, by: 'email', issue_key: t.shared })
    expect(res.status).toBe(409)
  })

  it('AND THE HONEST REPLAY STILL WORKS — same key, same operation', async () => {
    // The narrowing must not have cost the behaviour it was protecting.
    const t = await twoDonors('ok')
    const again = await t.auth(request(app).post('/api/giving-statements/issue'))
      .send({ year: 2026, key: t.alpha, by: 'email', issue_key: t.shared })
    expect(again.status).toBe(200)
    expect(again.body.replayed).toBe(true)
    expect(again.body.statement.id).toBe(t.stA.body.statement.id)

    // …including a correction retried with its own key.
    const corrKey = `ik-corr-ok-${RUN_ID}`
    const one = await t.auth(request(app).post(`/api/giving-statements/issued/${t.stB.body.statement.id}/supersede`))
      .send({ issue_key: corrKey })
    expect(one.status).toBe(201)
    const two = await t.auth(request(app).post(`/api/giving-statements/issued/${t.stB.body.statement.id}/supersede`))
      .send({ issue_key: corrKey })
    expect(two.status).toBe(200)
    expect(two.body.replayed).toBe(true)
    expect(Number(two.body.statement.id)).toBe(Number(one.body.statement.id))
  })
})

describe('tenancy fails closed (GIV-09)', () => {
  it('another parish cannot read, supersede, or link to this claim', async () => {
    const mine = await parish('tenant-a')
    const theirs = await parish('tenant-b')
    const issued = await mine.issue(`ik-ten-${RUN_ID}`)
    const id = issued.body.statement.id

    const read = await theirs.auth(request(app).get(`/api/giving-statements/issued/${id}`))
    expect(read.status).toBe(404)

    const sup = await theirs.auth(request(app).post(`/api/giving-statements/issued/${id}/supersede`))
      .send({ issue_key: `ik-ten-x-${RUN_ID}` })
    expect(sup.status).toBe(404)

    // And the database refuses a cross-tenant successor link outright.
    const foreign = await theirs.issue(`ik-ten-y-${RUN_ID}`)
    await expect(
      pool.query(
        `UPDATE ochr_giving_statements SET status='superseded', superseded_by_id=$2, superseded_at=NOW() WHERE id=$1`,
        [id, foreign.body.statement.id]
      )
    ).rejects.toThrow(/violates foreign key constraint/)
  })
})
