// One process TZ, one Postgres session TimeZone. Spawned by
// undatedDonationDate.test.js. The clock under test is frozen at
// 2026-09-28T06:30:00Z:
//   America/Los_Angeles is still 2026-09-27 (23:30 PDT).
//   Pacific/Auckland is 2026-09-28 (19:30 NZDT).
//   The UTC day is 2026-09-28.
// An undated gift must store each parish's own civil day. A UTC default,
// CURRENT_DATE, or the process-local day is one day for both parishes
// and cannot satisfy both.

const sessionTz = process.env.PG_SESSION_TZ || 'UTC'
if (!/^[A-Za-z0-9_+/-]+$/.test(sessionTz)) {
  console.error(JSON.stringify({ ok: false, fails: [{ name: 'session-tz', got: sessionTz, expected: 'IANA zone' }] }))
  process.exit(1)
}

const pg = (await import('pg')).default
const originalConnect = pg.Client.prototype.connect
pg.Client.prototype.connect = function connectWithSessionZone(callback) {
  if (callback) {
    return originalConnect.call(this, (err) => {
      if (err) return callback(err)
      this.query(`SET TIME ZONE '${sessionTz}'`, (qerr) => callback(qerr))
    })
  }
  return originalConnect.call(this).then(() => this.query(`SET TIME ZONE '${sessionTz}'`)).then(() => this)
}

const { default: pool } = await import('../src/db.js')
const jwt = (await import('jsonwebtoken')).default
const request = (await import('supertest')).default
const { bindServer, closeServer, migrateOnce } = await import('./support/harness.js')

const INSTANT = '2026-09-28T06:30:00.000Z'
const LA = 'America/Los_Angeles'
const AKL = 'Pacific/Auckland'
const LA_DAY = '2026-09-27'
const AKL_DAY = '2026-09-28'
const processTz = process.env.TZ || 'unset'
const fails = []
let currentDate = null

function check(name, got, expected) {
  if (got !== expected) fails.push({ name, got: got ?? null, expected })
}

function freezeAt(iso) {
  const RealDate = Date
  const fixed = new RealDate(iso).getTime()
  function FrozenDate(...args) {
    if (args.length === 0) return new RealDate(fixed)
    return new RealDate(...args)
  }
  FrozenDate.now = () => fixed
  FrozenDate.parse = RealDate.parse
  FrozenDate.UTC = RealDate.UTC
  FrozenDate.prototype = RealDate.prototype
  globalThis.Date = FrozenDate
  return () => { globalThis.Date = RealDate }
}

function sign(userId, organizationId, tv) {
  return jwt.sign(
    { userId, organizationId, role: 'admin', tv },
    process.env.JWT_SECRET || 'dev-only-change-me-please',
    { expiresIn: '1h' },
  )
}

let server
const orgIds = []
const userIds = []
const donationIds = []

try {
  await migrateOnce()
  const shown = await pool.query('SHOW timezone')
  const sessionShown = shown.rows[0]?.TimeZone ?? shown.rows[0]?.timezone ?? null
  check('session.timezone', sessionShown, sessionTz)

  const run = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  async function insertOrg(name, slug, timezone) {
    const { rows } = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, org_type, timezone)
       VALUES ($1, $2, 'parish', $3) RETURNING id`,
      [name, slug, timezone],
    )
    orgIds.push(rows[0].id)
    return rows[0].id
  }
  async function insertUser(organizationId, email) {
    const { rows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Admin', $2, 'x', 'admin') RETURNING id, token_version`,
      [organizationId, email],
    )
    userIds.push(rows[0].id)
    return rows[0]
  }

  const laId = await insertOrg(`Undated LA ${run}`, `undated-la-${run}`, LA)
  const aklId = await insertOrg(`Undated Auckland ${run}`, `undated-akl-${run}`, AKL)
  server = await bindServer()

  const thaw = freezeAt(INSTANT)
  try {
    const laUser = await insertUser(laId, `undated_la_${run}@example.com`)
    const aklUser = await insertUser(aklId, `undated_akl_${run}@example.com`)
    const post = (token, body) => request(server)
      .post('/api/donations')
      .set('Authorization', `Bearer ${token}`)
      .send(body)

    const laGift = await post(sign(laUser.id, laId, laUser.token_version), {
      donor_name: `Undated LA ${run}`,
      amount: 18,
      method: 'cash',
    })
    const aklGift = await post(sign(aklUser.id, aklId, aklUser.token_version), {
      donor_name: `Undated Auckland ${run}`,
      amount: 18,
      method: 'cash',
    })
    const explicit = await post(sign(laUser.id, laId, laUser.token_version), {
      donor_name: `Dated LA ${run}`,
      amount: 5,
      method: 'cash',
      date: '2020-01-02',
    })

    check('la.status', laGift.status, 201)
    check('akl.status', aklGift.status, 201)
    check('explicit.status', explicit.status, 201)
    check('la.api', laGift.body?.date, LA_DAY)
    check('akl.api', aklGift.body?.date, AKL_DAY)
    check('explicit.api', explicit.body?.date, '2020-01-02')
    const posted = [
      ['la', laGift.body?.id, LA_DAY],
      ['akl', aklGift.body?.id, AKL_DAY],
      ['explicit', explicit.body?.id, '2020-01-02'],
    ]
    for (const [, id] of posted) if (id) donationIds.push(id)
    const storedIds = posted.map(([, id]) => id).filter(Boolean)
    if (storedIds.length) {
      const { rows } = await pool.query(
        `SELECT id, to_char(date, 'YYYY-MM-DD') AS date
           FROM ochr_donations WHERE id = ANY($1::int[])`,
        [storedIds],
      )
      const byId = new Map(rows.map(r => [String(r.id), r.date]))
      for (const [name, id, expected] of posted) {
        check(`${name}.stored`, id ? byId.get(String(id)) : null, expected)
      }
    }
  } finally {
    thaw()
  }

  const clock = await pool.query(`SELECT CURRENT_DATE::text AS current_date`)
  currentDate = clock.rows[0]?.current_date ?? null
} catch (err) {
  fails.push({ name: 'threw', got: err?.stack || err?.message || String(err), expected: null })
} finally {
  if (donationIds.length) {
    await pool.query('DELETE FROM ochr_donations WHERE id = ANY($1::int[])', [donationIds]).catch(() => {})
  }
  if (orgIds.length) {
    await pool.query('DELETE FROM ochr_audit_log WHERE organization_id = ANY($1::int[])', [orgIds]).catch(() => {})
  }
  if (userIds.length) await pool.query('DELETE FROM ochr_users WHERE id = ANY($1::int[])', [userIds]).catch(() => {})
  if (orgIds.length) await pool.query('DELETE FROM ochr_organizations WHERE id = ANY($1::int[])', [orgIds]).catch(() => {})
  await closeServer(server)
  await pool.end()
}

const la = fails.find(f => f.name === 'la.stored')?.got ?? (fails.some(f => f.name.startsWith('la.')) ? null : LA_DAY)
const akl = fails.find(f => f.name === 'akl.stored')?.got ?? (fails.some(f => f.name.startsWith('akl.')) ? null : AKL_DAY)
const report = { tz: processTz, session: sessionTz, instant: INSTANT, currentDate, la, akl, ok: fails.length === 0, fails }
if (fails.length) {
  console.error(JSON.stringify(report, null, 2))
  process.exit(1)
}
console.log(JSON.stringify(report))
