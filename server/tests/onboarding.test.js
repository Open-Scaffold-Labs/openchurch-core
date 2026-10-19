// A parish's first week — the welcome layer and the people it invites.
//
// Extracted from smoke.test.js, which had grown past 15,000 lines. These
// blocks moved because they already stood alone: each signs up its own
// parish and shares nothing with the rest of the suite. Nothing about them
// changed in the move — same assertions, same fixtures, same names.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
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

describe('staff invitations (PILOT.2)', () => {
  // Adding a colleague used to go through POST /api/users, which creates
  // the account AND sets its password — so an administrator had to invent
  // one and convey it, which means the administrator knows it, the
  // conveyance is usually a chat message, and almost nobody changes it
  // afterwards. That is credential sharing with a form around it, and not
  // something to hand a real diocese during a pilot.
  //
  // An invitation instead: the account exists immediately and is unusable,
  // and the person sets their own password from a one-time link.
  const chancery = {
    organizationName: `Invite Chancery ${RUN_ID}`, name: 'Canon Admin',
    email: `inv_${RUN_ID}@example.com`, password: 'smoke-test-pw-95',
    organizationType: 'diocese',
  }
  const other = {
    organizationName: `Invite Other ${RUN_ID}`, name: 'Other Admin',
    email: `invoth_${RUN_ID}@example.com`, password: 'smoke-test-pw-96',
    organizationType: 'diocese',
  }
  let admin, otherTok, inviteeId, inviteUrl
  const inviteeEmail = `invitee_${RUN_ID}@example.com`
  const CHOSEN = 'the-invitee-chose-this-one'

  const tokenFrom = (url) => new URL(url).searchParams.get('token')

  beforeAll(async () => {
    const mk = async (payload, ip) => {
      const r = await createOrg(server, payload, ip)
      expect(r.status).toBe(201)
      return r.body.token
    }
    admin = await mk(chancery, '10.99.12.41')
    otherTok = await mk(other, '10.99.12.42')
  })

  it('A CHANCERY INVITATION OPENS THE CHANCERY APP, NOT THE PARISH ONE', async () => {
    // The first cut sent every invitation to CLIENT_URL — the parish app —
    // so a chancery colleague would land in the wrong product entirely.
    const res = await request(server).post('/api/users/invite')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Door Test', email: `door_${RUN_ID}@example.com`, role: 'staff' })
    expect(res.status).toBe(201)
    expect(res.body.invite.url).toContain(':5204')
    expect(res.body.invite.url).not.toContain(':5202')
  })

  it('an invitation creates the account and returns a link, not a password', async () => {
    const res = await request(server).post('/api/users/invite')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Invited Canon', email: inviteeEmail, role: 'staff' })
    expect(res.status).toBe(201)
    inviteeId = res.body.user.id
    inviteUrl = res.body.invite.url

    expect(res.body.user.pending).toBe(true)
    expect(res.body.user.invited_by_name).toBe('Canon Admin')
    // The whole point: nothing in the response is a credential the
    // administrator could keep and reuse.
    const blob = JSON.stringify(res.body).toLowerCase()
    expect(blob).not.toContain('password')
    expect(res.body.invite.expires_at).toBeTruthy()
  })

  it('THE ACCOUNT CANNOT BE SIGNED INTO BEFORE THE INVITATION IS ACCEPTED', async () => {
    // It is created with a hash of random bytes nobody holds, so there is
    // no password to guess, share or leak — not a null password, which
    // every login path would have to remember to check.
    for (const guess of ['', 'password', 'changeme', 'smoke-test-pw-95']) {
      const res = await request(server).post('/api/auth/login')
        .set('X-Forwarded-For', '10.99.12.43')
        .send({ email: inviteeEmail, password: guess })
      expect(res.status).not.toBe(200)
    }
  })

  it('the pending invitation is visible to the chancery', async () => {
    const res = await request(server).get('/api/users').set('Authorization', `Bearer ${admin}`)
    expect(res.status).toBe(200)
    const row = res.body.find(u => u.id === inviteeId)
    expect(row.pending).toBe(true)
    expect(row.invited_at).toBeTruthy()
  })

  it('resending kills the previous link', async () => {
    const first = tokenFrom(inviteUrl)
    const again = await request(server).post(`/api/users/${inviteeId}/invite/resend`)
      .set('Authorization', `Bearer ${admin}`).send({})
    expect(again.status).toBe(200)
    const second = tokenFrom(again.body.invite.url)
    expect(second).not.toBe(first)

    // An invitation forwarded to the wrong person stops working the moment
    // it is resent.
    const stale = await request(server).post('/api/auth/accept-invite')
      .send({ token: first, password: CHOSEN })
    expect(stale.status).toBe(400)
    inviteUrl = again.body.invite.url
  })

  it('accepting it sets a password only the invitee knows, and signs them in', async () => {
    const { rows: orgRows } = await pool.query(
      'SELECT organization_id FROM ochr_users WHERE email = $1',
      [chancery.email]
    )
    await pool.query(
      `UPDATE ochr_organizations SET timezone = 'America/Chicago' WHERE id = $1`,
      [orgRows[0].organization_id]
    )
    const res = await request(server).post('/api/auth/accept-invite')
      .send({ token: tokenFrom(inviteUrl), password: CHOSEN })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeTruthy()
    expect(res.body.user.organization.name).toBe(chancery.organizationName)
    expect(res.body.user.organization.timezone).toBe('America/Chicago')

    const login = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.99.12.44')
      .send({ email: inviteeEmail, password: CHOSEN })
    expect(login.status).toBe(200)
  })

  it('accepting an invite echoes an invalid stored zone as UTC', async () => {
    const { rows: orgRows } = await pool.query(
      'SELECT organization_id FROM ochr_users WHERE email = $1',
      [chancery.email]
    )
    const orgId = orgRows[0].organization_id
    await pool.query(
      `UPDATE ochr_organizations SET timezone = 'Not/AZone' WHERE id = $1`,
      [orgId]
    )
    try {
      const fresh = await request(server).post('/api/users/invite')
        .set('Authorization', `Bearer ${admin}`)
        .send({ name: 'Zone Invitee', email: `zone_${RUN_ID}@example.com`, role: 'staff' })
      expect(fresh.status).toBe(201)
      const accepted = await request(server).post('/api/auth/accept-invite')
        .send({ token: tokenFrom(fresh.body.invite.url), password: 'zone-invitee-password' })
      expect(accepted.status).toBe(200)
      expect(accepted.body.user.organization.timezone).toBe('UTC')
    } finally {
      await pool.query(
        `UPDATE ochr_organizations SET timezone = 'America/Chicago' WHERE id = $1`,
        [orgId]
      )
    }
  })

  it('the token it returns actually works — accepting does not sign you out', async () => {
    // token_version is incremented on acceptance, so a token minted with
    // the OLD version would be rejected on the very next request.
    const fresh = await request(server).post('/api/users/invite')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Second Invitee', email: `invitee2_${RUN_ID}@example.com`, role: 'staff' })
    const accepted = await request(server).post('/api/auth/accept-invite')
      .send({ token: tokenFrom(fresh.body.invite.url), password: 'second-invitee-password' })
    expect(accepted.status).toBe(200)

    const me = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${accepted.body.token}`)
    expect(me.status).toBe(200)
  })

  it('an invitation cannot be accepted twice', async () => {
    const res = await request(server).post('/api/auth/accept-invite')
      .send({ token: tokenFrom(inviteUrl), password: 'another-password-entirely' })
    expect(res.status).toBe(400)   // the token was consumed
  })

  it('resending to somebody who already accepted is refused, kindly', async () => {
    const res = await request(server).post(`/api/users/${inviteeId}/invite/resend`)
      .set('Authorization', `Bearer ${admin}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/reset their own password/i)
  })

  it('a garbage or expired link says one thing, never which', async () => {
    const res = await request(server).post('/api/auth/accept-invite')
      .send({ token: 'not-a-real-token-at-all', password: 'some-password-here' })
    expect(res.status).toBe(400)
    // Distinguishing "expired" from "never existed" tells an attacker
    // which guesses were close.
    expect(res.body.error).toMatch(/no longer valid/i)
  })

  it('ANOTHER DIOCESE CANNOT INVITE INTO THIS ONE, OR RESEND ITS INVITATIONS', async () => {
    const resend = await request(server).post(`/api/users/${inviteeId}/invite/resend`)
      .set('Authorization', `Bearer ${otherTok}`).send({})
    expect(resend.status).toBe(404)

    // An invitation sent by another diocese lands in THAT diocese, never here.
    const theirs = await request(server).post('/api/users/invite')
      .set('Authorization', `Bearer ${otherTok}`)
      .send({ name: 'Theirs', email: `theirs_${RUN_ID}@example.com`, role: 'staff' })
    expect(theirs.status).toBe(201)
    const mine = await request(server).get('/api/users').set('Authorization', `Bearer ${admin}`)
    expect(mine.body.map(u => u.id)).not.toContain(theirs.body.user.id)
  })

  it('an invitation may carry pastoral leadership, and defaults to not', async () => {
    const plain = await request(server).post('/api/users/invite')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Plain Staff', email: `plain_${RUN_ID}@example.com`, role: 'staff' })
    expect(plain.body.user.pastoral_lead).toBe(false)

    const lead = await request(server).post('/api/users/invite')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Lead Canon', email: `lead_${RUN_ID}@example.com`, role: 'staff', pastoral_lead: true })
    expect(lead.body.user.pastoral_lead).toBe(true)
  })

  it('a bad role or a duplicate email is refused before anything is created', async () => {
    const badRole = await request(server).post('/api/users/invite')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'X', email: `role_${RUN_ID}@example.com`, role: 'bishop' })
    expect(badRole.status).toBe(400)

    const dupe = await request(server).post('/api/users/invite')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Again', email: inviteeEmail, role: 'staff' })
    expect(dupe.status).toBe(409)
    expect(dupe.body.error).toMatch(/already has an account/i)
  })

  it('a staff user cannot invite anybody', async () => {
    const staffLogin = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.99.12.45')
      .send({ email: inviteeEmail, password: CHOSEN })
    expect(staffLogin.status).toBe(200)

    const res = await request(server).post('/api/users/invite')
      .set('Authorization', `Bearer ${staffLogin.body.token}`)
      .send({ name: 'Sneaky', email: `sneaky_${RUN_ID}@example.com`, role: 'admin' })
    expect(res.status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Getting settled — orientation without a denominator
//
// The feature's whole claim is that it helps without pressuring, and the
// only part of that a test can actually hold is the vocabulary and the
// absence of a total. So the vocabulary IS a test here, run against the
// shipped strings rather than against a screenshot: if somebody
// reintroduces "complete your profile" or a percentage in six months,
// this goes red in CI and not in a parish.
//
// The other half is ordinary and unglamorous: a viewer must not be sent
// an invitation action, a non-admin must not reach the setup record, and
// one parish's record must never mention another's.
// ─────────────────────────────────────────────────────────────────────────
describe('Getting settled — a calm first week', () => {
  const org = {
    organizationName: `Settling Parish ${RUN_ID}`, name: 'Sadie Admin',
    email: `settle_admin_${RUN_ID}@example.com`, password: 'smoke-test-pw-settle-1',
  }
  const other = {
    organizationName: `Other Settling Parish ${RUN_ID}`, name: 'Otto Admin',
    email: `settle_other_${RUN_ID}@example.com`, password: 'smoke-test-pw-settle-2',
  }
  let tok, otherTok, orgId, viewerTok, staffTok

  beforeAll(async () => {
    const mk = async (payload, ip) => {
      const r = await createOrg(server, payload, ip)
      expect(r.status).toBe(201)
      return { token: r.body.token, orgId: r.body.user.organization.id }
    }
    const a = await mk(org, '10.99.15.11')
    tok = a.token; orgId = a.orgId
    otherTok = (await mk(other, '10.99.15.12')).token

    const mkUser = async (role, email) => {
      const c = await request(server).post('/api/users').set('Authorization', `Bearer ${tok}`)
        .send({ name: `${role} person`, email, password: 'smoke-test-pw-settle-3', role })
      expect(c.status).toBeLessThan(300)
      const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', '10.99.15.13')
        .send({ email, password: 'smoke-test-pw-settle-3' })
      expect(l.status).toBe(200)
      return l.body.token
    }
    viewerTok = await mkUser('viewer', `settle_viewer_${RUN_ID}@example.com`)
    staffTok  = await mkUser('staff',  `settle_staff_${RUN_ID}@example.com`)
  })

  it('A NEW PARISH IS ORIENTED WITHOUT BEING BLOCKED', async () => {
    const res = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(res.status).toBe(200)
    expect(res.body.parish).toBe(`Settling Parish ${RUN_ID}`)
    // The ledger holds only true things, and the workspace itself is one.
    expect(res.body.in_place.some(e => e.key === 'setup.inPlace.workspace')).toBe(true)
    // Nothing anywhere in the payload is a total, a score, or a fraction.
    expect(res.body).not.toHaveProperty('progress')
    expect(res.body).not.toHaveProperty('total')
    expect(res.body).not.toHaveProperty('completed')
    expect(res.body).not.toHaveProperty('percent')
    // And normal work is untouched: the dashboard's own data still loads.
    const dash = await request(server).get('/api/clients').set('Authorization', `Bearer ${tok}`)
    expect(dash.status).toBe(200)
  })

  it('NOTHING IN THE LEDGER IS A THING THAT HAS NOT HAPPENED', async () => {
    const res = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    // Every entry is a positive fact. A 'pending'/'done' flag anywhere
    // would be the empty half of the bar wearing a different hat.
    for (const e of res.body.in_place) {
      expect(e).not.toHaveProperty('done')
      expect(e).not.toHaveProperty('pending')
      expect(e).not.toHaveProperty('state')
      expect(e.key.startsWith('setup.inPlace.')).toBe(true)
    }
    // The suggestions are capped, so they can never be read as a set to
    // get through.
    expect(res.body.begin_here.length).toBeLessThanOrEqual(3)
  })

  it('a parish with no import is oriented toward bringing one in', async () => {
    const res = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(res.body.import_context).toBeNull()
    expect(res.body.begin_here.some(b => b.key === 'setup.begin.migration')).toBe(true)
  })

  it('A POST-IMPORT PARISH SEES ITS OWN IMPORT, ACCURATELY', async () => {
    // Constructed directly rather than driven through Migration Studio:
    // what is under test is that the setup page reads the receipt
    // faithfully, and building the receipt is the Studio's own tested
    // job. The shape here is exactly what imports.js writes.
    const receipt = {
      imported: 214, skipped: 3, held_for_follow_up: 7,
      duplicates_left_for_review: 2, ignored_columns: ['legacy_id', 'notes2'],
      protection: {
        source_file: 'The original file was not stored. Keep your own copy of the file.',
        staged_rows: 'The rows the Studio read from the file are kept for 30 days after this import finished, then removed.',
      },
      retention_days: 30,
    }
    const b = await pool.query(
      `INSERT INTO ochr_import_batches
         (organization_id, kind, source_name, status, row_count, headers, mapping, receipt, committed_at, created_by)
       VALUES ($1, 'members', 'stanne-members.csv', 'committed', 219, $3, $4, $2, NOW(), NULL)
       RETURNING id`,
      [orgId, JSON.stringify(receipt), JSON.stringify(['name', 'email']), JSON.stringify({ name: 'name', email: 'email' })])
    const batchId = b.rows[0].id

    const res = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(res.body.import_context).toBeTruthy()
    expect(res.body.import_context.imported).toBe(214)
    expect(res.body.import_context.held_for_follow_up).toBe(7)
    expect(res.body.import_context.ignored_columns).toEqual(['legacy_id', 'notes2'])
    // The sentence about the source file is COPIED from the receipt, not
    // rewritten here — this page must never be where the promise drifts
    // into claiming the file was archived.
    expect(res.body.import_context.protection.source_file).toBe(receipt.protection.source_file)
    expect(JSON.stringify(res.body)).not.toMatch(/file (was )?(archived|stored|kept) (for|with)/i)

    // The ledger gains an entry, and the suggestions now lead with the
    // receipt rather than with Migration Studio.
    expect(res.body.in_place.some(e => e.key === 'setup.inPlace.import')).toBe(true)
    expect(res.body.begin_here[0].key).toBe('setup.begin.receipt')
    expect(res.body.begin_here[0].to).toBe(`/migration/${batchId}/receipt`)
    const followUp = res.body.begin_here.find(x => x.key === 'setup.begin.followUp')
    expect(followUp.count).toBe(9)   // 7 held + 2 duplicates left for review
    expect(res.body.begin_here.map(x => x.key)).not.toContain('setup.begin.migration')

    // A viewer must not learn any of it. Migration Studio is admin-only,
    // so its receipt is too.
    const v = await request(server).get('/api/setup').set('Authorization', `Bearer ${viewerTok}`)
    expect(v.body.import_context).toBeNull()
    expect(v.body.begin_here.map(x => x.key)).not.toContain('setup.begin.receipt')

    // And the record reports the unresolved count truthfully.
    const rec = await request(server).get('/api/setup/record').set('Authorization', `Bearer ${tok}`)
    expect(rec.body.latest_import.imported).toBe(214)
    expect(rec.body.latest_import.held_at_the_time).toBe(9)

    await pool.query('DELETE FROM ochr_import_batches WHERE id = $1', [batchId])
  })

  it('A VIEWER IS NEVER SENT AN ACTION IT CANNOT TAKE', async () => {
    const res = await request(server).get('/api/setup').set('Authorization', `Bearer ${viewerTok}`)
    expect(res.status).toBe(200)
    expect(res.body.can_invite).toBe(false)
    expect(res.body.can_import).toBe(false)
    // Filtered at the SOURCE, not hidden by the client: the payload does
    // not contain the action at all.
    const keys = res.body.begin_here.map(b => b.key)
    expect(keys).not.toContain('setup.begin.invite')
    expect(keys).not.toContain('setup.begin.migration')
    expect(keys).not.toContain('setup.begin.context')
    // Nor does it learn the composition of the staff list.
    const people = res.body.in_place.find(e => e.key === 'setup.inPlace.people')
    if (people) expect(people.detail).not.toHaveProperty('by_role')
  })

  it('staff get a rhythm, not an administration console', async () => {
    const res = await request(server).get('/api/setup').set('Authorization', `Bearer ${staffTok}`)
    const keys = res.body.begin_here.map(b => b.key)
    expect(keys).toContain('setup.begin.week')
    expect(keys).not.toContain('setup.begin.invite')
  })

  it('THE SETUP RECORD IS ADMIN-ONLY AND TENANT-SCOPED', async () => {
    for (const t of [viewerTok, staffTok]) {
      const denied = await request(server).get('/api/setup/record').set('Authorization', `Bearer ${t}`)
      expect(denied.status).toBe(403)
    }
    const mine = await request(server).get('/api/setup/record').set('Authorization', `Bearer ${tok}`)
    expect(mine.status).toBe(200)
    expect(mine.body.parish).toBe(`Settling Parish ${RUN_ID}`)

    // The other parish's admin sees only its own, and never this one.
    const theirs = await request(server).get('/api/setup/record').set('Authorization', `Bearer ${otherTok}`)
    expect(theirs.status).toBe(200)
    expect(theirs.body.parish).toBe(`Other Settling Parish ${RUN_ID}`)
    // Names, not the parish string — "Other Settling Parish X" contains
    // "Settling Parish X" as a substring, so a naive contains() check
    // here passes for the wrong reason and would keep passing if the
    // tenant scope broke. The people are the real test.
    const theirNames = theirs.body.access.map(p => p.name)
    expect(theirNames).toContain('Otto Admin')
    expect(theirNames).not.toContain('Sadie Admin')
    expect(theirNames).not.toContain('viewer person')
    expect(mine.body.access.map(p => p.name)).not.toContain('Otto Admin')
  })

  it('the record carries no email addresses and no scoring language', async () => {
    const res = await request(server).get('/api/setup/record').set('Authorization', `Bearer ${tok}`)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('@example.com')
    for (const word of ['percent', 'score', 'completion', 'progress', 'required', 'at_risk', 'health']) {
      expect(body.toLowerCase()).not.toContain(word)
    }
    // Access is by name and role, which is what a handover needs.
    expect(res.body.access.every(p => p.name && p.role)).toBe(true)
    expect(res.body.access.some(p => p.role === 'viewer')).toBe(true)
  })

  it('A VIEWER CAN PUT AWAY HER OWN CARD', async () => {
    // This shipped broken. /api/setup was mounted behind writeGate, which
    // allows a non-GET only for admin and staff — so a viewer saw the
    // card, pressed "come back to this later", and got a 403 while the
    // page told her it was saved. The least-privileged user is exactly
    // the one most likely to want the orientation out of the way, and
    // her own dashboard preference is not a parish mutation.
    await request(server).post('/api/setup/dismiss')
      .set('Authorization', `Bearer ${viewerTok}`).expect(204)
    const v = await request(server).get('/api/setup').set('Authorization', `Bearer ${viewerTok}`)
    expect(v.body.dismissed_at).not.toBeNull()

    await request(server).delete('/api/setup/dismiss')
      .set('Authorization', `Bearer ${viewerTok}`).expect(204)
    const back = await request(server).get('/api/setup').set('Authorization', `Bearer ${viewerTok}`)
    expect(back.body.dismissed_at).toBeNull()

    // Dropping writeGate must not have opened anything else to her.
    await request(server).post('/api/setup/later')
      .set('Authorization', `Bearer ${viewerTok}`)
      .send({ item_key: 'setup.begin.invite' }).expect(403)
    await request(server).get('/api/setup/record')
      .set('Authorization', `Bearer ${viewerTok}`).expect(403)
  })

  it('THE LEDGER DOES NOT COUNT A DEFAULT AS A CHOICE', async () => {
    // `tradition` falls back to 'general' for a parish that skipped the
    // question at signup (migration 072). Reading that as a chosen
    // tradition made the ledger claim "the parish reads in its own
    // tradition" of parishes that had chosen nothing — a small untruth,
    // in the one place on the site whose value is that every line is true.
    const before = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    const org = await pool.query('SELECT tradition FROM ochr_organizations WHERE id = $1', [orgId])
    expect(org.rows[0].tradition).toBe('general')
    expect(before.body.in_place.some(e => e.key === 'setup.inPlace.tradition')).toBe(false)

    // Name one, and it becomes true — and appears.
    await pool.query(`UPDATE ochr_organizations SET tradition = 'episcopal' WHERE id = $1`, [orgId])
    const after = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(after.body.in_place.some(e => e.key === 'setup.inPlace.tradition')).toBe(true)
    await pool.query(`UPDATE ochr_organizations SET tradition = 'general' WHERE id = $1`, [orgId])
  })

  it('nothing seeded as a sample is ever reported as the parish\'s own work', async () => {
    // A new workspace is seeded with '[Sample]' members, events and tasks
    // so the pages are not empty. Counting those would have the ledger
    // congratulate a parish on twelve members it has never met.
    const res = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    const samples = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_clients
        WHERE organization_id = $1 AND name LIKE '[Sample]%'`, [orgId])
    expect(samples.rows[0].n).toBeGreaterThan(0)
    expect(res.body.in_place.some(e => e.key === 'setup.inPlace.members')).toBe(false)
    expect(res.body.in_place.some(e => e.key === 'setup.inPlace.events')).toBe(false)
  })

  it('A PENDING INVITATION IS NOT ACCESS', async () => {
    // POST /api/users/invite writes the row immediately with
    // invite_accepted_at NULL and a password nobody holds. Counting it
    // had the ledger say "colleagues have been given access" of a parish
    // whose email is still unopened — and put that person in the printed
    // handover under "People with access".
    const before = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    const beforeCount = before.body.in_place.find(e => e.key === 'setup.inPlace.people')?.detail?.count

    const inv = await request(server).post('/api/users/invite').set('Authorization', `Bearer ${tok}`)
      .send({ email: `settle_pending_${RUN_ID}@example.com`, name: 'Never Opened It', role: 'staff' })
    expect(inv.status).toBeLessThan(300)

    const after = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(after.body.in_place.find(e => e.key === 'setup.inPlace.people')?.detail?.count).toBe(beforeCount)

    const rec = await request(server).get('/api/setup/record').set('Authorization', `Bearer ${tok}`)
    expect(rec.body.access.map(p => p.name)).not.toContain('Never Opened It')
  })

  it('THE LEDGER DOES NOT READ A NOT-NULL DEFAULT AS A CHOICE', async () => {
    // `timezone` is NOT NULL DEFAULT 'UTC' (migration 040). This signup
    // does not submit a zone, so the column stays the default. Treating
    // that default as a chosen clock made `o.address && o.timezone`
    // collapse to `o.address`, and the same expression suppressed the
    // "confirm the parish details" suggestion.
    const tz = await pool.query('SELECT address, timezone FROM ochr_organizations WHERE id = $1', [orgId])
    expect(tz.rows[0].timezone).toBe('UTC')
    expect(tz.rows[0].address).toBeNull()

    const before = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(before.body.in_place.some(e => e.key === 'setup.inPlace.context')).toBe(false)
    expect(before.body.begin_here.map(b => b.key)).toContain('setup.begin.context')

    await pool.query(`UPDATE ochr_organizations SET address = '1 Parish Lane' WHERE id = $1`, [orgId])
    const after = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(after.body.in_place.some(e => e.key === 'setup.inPlace.context')).toBe(true)
    expect(after.body.begin_here.map(b => b.key)).not.toContain('setup.begin.context')
    await pool.query(`UPDATE ochr_organizations SET address = NULL WHERE id = $1`, [orgId])
  })

  it('A DEFERRAL RETIRES ITSELF WHEN THE THING BECOMES TRUE', async () => {
    // Otherwise the page shows "Parish details are on file" and "Left for
    // later, on purpose — Confirm the parish details" at the same time,
    // and so does the printed handover.
    await request(server).post('/api/setup/later').set('Authorization', `Bearer ${tok}`)
      .send({ item_key: 'setup.begin.context' }).expect(204)
    const deferred = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(deferred.body.deferred.some(d => d.item_key === 'setup.begin.context')).toBe(true)

    await pool.query(`UPDATE ochr_organizations SET address = '1 Parish Lane' WHERE id = $1`, [orgId])
    const done = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(done.body.in_place.some(e => e.key === 'setup.inPlace.context')).toBe(true)
    expect(done.body.deferred.some(d => d.item_key === 'setup.begin.context')).toBe(false)

    const rec = await request(server).get('/api/setup/record').set('Authorization', `Bearer ${tok}`)
    expect(rec.body.left_for_later.some(d => d.item_key === 'setup.begin.context')).toBe(false)

    await pool.query(`UPDATE ochr_organizations SET address = NULL WHERE id = $1`, [orgId])
    await request(server).delete('/api/setup/later/setup.begin.context')
      .set('Authorization', `Bearer ${tok}`).expect(204)
  })

  it('a deferral is never shown to someone who cannot make one', async () => {
    await request(server).post('/api/setup/later').set('Authorization', `Bearer ${tok}`)
      .send({ item_key: 'setup.begin.invite' }).expect(204)
    for (const t of [viewerTok, staffTok]) {
      const res = await request(server).get('/api/setup').set('Authorization', `Bearer ${t}`)
      // `noted_by` is a snapshotted full name, and the items name
      // admin-only surfaces.
      expect(res.body.deferred).toEqual([])
      expect(JSON.stringify(res.body)).not.toContain('Sadie Admin')
    }
    await request(server).delete('/api/setup/later/setup.begin.invite')
      .set('Authorization', `Bearer ${tok}`).expect(204)
  })

  it('EVERY OFFERED "LEAVE FOR LATER" IS ONE THE SERVER ACCEPTS', async () => {
    // The button used to render on every suggestion, including the import
    // receipt — which is not deferrable and is the FIRST item after an
    // import, so the most prominent control on the page was a guaranteed
    // 400 and an error toast.
    const res = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    for (const item of res.body.begin_here) {
      expect(item).toHaveProperty('deferrable')
      const attempt = await request(server).post('/api/setup/later')
        .set('Authorization', `Bearer ${tok}`).send({ item_key: item.key })
      expect(attempt.status).toBe(item.deferrable ? 204 : 400)
      if (item.deferrable) {
        await request(server).delete(`/api/setup/later/${encodeURIComponent(item.key)}`)
          .set('Authorization', `Bearer ${tok}`).expect(204)
      }
    }
  })

  it('A DEMOTED ADMIN LOSES THE RECORD IMMEDIATELY, NOT IN SEVEN DAYS', async () => {
    // requireAuth builds req.user.role from the JWT, and PATCH
    // /api/users/:id/role does not bump token_version — so a role read
    // from the token stays admin for up to seven days after a demotion.
    // The router refreshes it from the database, like every other admin
    // surface in the app.
    const email = `settle_demote_${RUN_ID}@example.com`
    const created = await request(server).post('/api/users').set('Authorization', `Bearer ${tok}`)
      .send({ name: 'Soon Demoted', email, password: 'smoke-test-pw-settle-4', role: 'admin' })
    expect(created.status).toBeLessThan(300)
    const login = await request(server).post('/api/auth/login').set('X-Forwarded-For', '10.99.15.14')
      .send({ email, password: 'smoke-test-pw-settle-4' })
    const theirTok = login.body.token

    const allowed = await request(server).get('/api/setup/record').set('Authorization', `Bearer ${theirTok}`)
    expect(allowed.status).toBe(200)

    await pool.query(`UPDATE ochr_users SET role = 'viewer' WHERE email = $1`, [email])

    // SAME token, no re-login.
    const refused = await request(server).get('/api/setup/record').set('Authorization', `Bearer ${theirTok}`)
    expect(refused.status).toBe(403)
    const payload = await request(server).get('/api/setup').set('Authorization', `Bearer ${theirTok}`)
    expect(payload.body.can_invite).toBe(false)
    expect(payload.body.import_context).toBeNull()
  })

  it('DISMISSAL IS PER PERSON, AND REVERSIBLE', async () => {
    await request(server).post('/api/setup/dismiss').set('Authorization', `Bearer ${tok}`).expect(204)

    const admin = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(admin.body.dismissed_at).not.toBeNull()

    // The staff member invited later is exactly the reader the
    // orientation was written for. The admin putting it away must not
    // decide that for her.
    const staff = await request(server).get('/api/setup').set('Authorization', `Bearer ${staffTok}`)
    expect(staff.body.dismissed_at).toBeNull()

    // And it never hides the destination, only the card.
    expect(admin.body.in_place.length).toBeGreaterThan(0)
    expect(admin.status).toBe(200)

    await request(server).delete('/api/setup/dismiss').set('Authorization', `Bearer ${tok}`).expect(204)
    const back = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(back.body.dismissed_at).toBeNull()
  })

  it('another parish cannot dismiss or defer on this one\'s behalf', async () => {
    await request(server).post('/api/setup/dismiss').set('Authorization', `Bearer ${otherTok}`).expect(204)
    const mine = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(mine.body.dismissed_at).toBeNull()

    await request(server).post('/api/setup/later').set('Authorization', `Bearer ${otherTok}`)
      .send({ item_key: 'setup.begin.invite' }).expect(204)
    const stillMine = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(stillMine.body.deferred).toHaveLength(0)
  })

  it('DEFERRING IS A DECISION WITH A NAME ON IT, NOT AN OMISSION', async () => {
    const nope = await request(server).post('/api/setup/later').set('Authorization', `Bearer ${staffTok}`)
      .send({ item_key: 'setup.begin.invite' })
    expect(nope.status).toBe(403)

    const bad = await request(server).post('/api/setup/later').set('Authorization', `Bearer ${tok}`)
      .send({ item_key: 'setup.begin.notAThing' })
    expect(bad.status).toBe(400)

    // 'setup.begin.week' rather than 'invite': this parish already has
    // colleagues, so an invite deferral correctly retires itself (see the
    // staleness test above). Preparing the week is never derivable-away,
    // which is what makes it the right subject for THIS test.
    await request(server).post('/api/setup/later').set('Authorization', `Bearer ${tok}`)
      .send({ item_key: 'setup.begin.week' }).expect(204)

    const res = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    const d = res.body.deferred.find(x => x.item_key === 'setup.begin.week')
    expect(d).toBeTruthy()
    expect(d.noted_by).toBe('Sadie Admin')
    // A deferred item stops being suggested — it was answered, not skipped.
    expect(res.body.begin_here.map(b => b.key)).not.toContain('setup.begin.week')

    // And the printed record says it was deliberate rather than missing.
    const rec = await request(server).get('/api/setup/record').set('Authorization', `Bearer ${tok}`)
    expect(rec.body.left_for_later.some(x => x.item_key === 'setup.begin.week')).toBe(true)
    expect(rec.body.left_for_later[0].noted_by).toBe('Sadie Admin')

    await request(server).delete('/api/setup/later/setup.begin.week')
      .set('Authorization', `Bearer ${tok}`).expect(204)
    const after = await request(server).get('/api/setup').set('Authorization', `Bearer ${tok}`)
    expect(after.body.deferred).toHaveLength(0)
  })

  it('NO PROGRESS, SCORING, OR ANXIETY VOCABULARY IN EITHER LANGUAGE', async () => {
    const { STRINGS } = await import('../../client/src/i18n/strings.js')
    // Run against the SHIPPED strings, so this fails in CI rather than in
    // a parish if somebody reintroduces the framing later.
    const banned = [
      /\bfinish setup\b/i, /\bcomplete your profile\b/i, /\bonboarding progress\b/i,
      /\byou are behind\b/i, /\brequired\b/i, /\bhealth\b/i, /\bscore\b/i,
      /\bat risk\b/i, /\btenant\b/i, /\bworkflow\b/i, /\bprogress\b/i,
      /\bcompletion\b/i, /\b\d+\s*%/, /\b\d+ of \d+\b/,
      // Spanish equivalents, checked explicitly rather than assumed to be
      // covered by the English list.
      /\bcompletar\b/i, /\bprogreso\b/i, /\bobligatorio\b/i, /\brequerido\b/i,
      /\bpuntuaci[oó]n\b/i, /\bva[s]? atrasad/i,
    ]
    const offenders = []
    for (const lang of ['en', 'es']) {
      for (const [key, value] of Object.entries(STRINGS[lang])) {
        if (!key.startsWith('settled.') && key !== 'nav.Getting settled') continue
        for (const re of banned) {
          if (re.test(String(value))) offenders.push(`${lang}:${key} → ${re}`)
        }
      }
    }
    expect(offenders).toEqual([])

    // Both languages actually exist for every key this feature ships.
    const en = Object.keys(STRINGS.en).filter(k => k.startsWith('settled.'))
    expect(en.length).toBeGreaterThan(40)
    expect(en.filter(k => !STRINGS.es[k])).toEqual([])
  })
})
