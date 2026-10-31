// Cutover scoreboard (Restaurant-deck pattern, José 2026-10-25): five weekly
// lines — cash, receivables, deposits, payables, trial balance — old system
// vs OpenChurch as of a date, built on the #413 parser and its complete flag.
// UNKNOWN/incomplete is never shown as $0.00; 'cutover ready' only when every
// line is a complete $0.00 match; the accountant sign-off is append-only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { signToken } from '../src/middleware/auth.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { scoreLines, toCents } from '../src/finance/cutover.js'
import { acquireSignoffLocks, signoffKeys, FINANCE_LOCK_NS, CHART_LOCK_NS } from '../src/finance/locks.js'

let BOOKS
let server, token, orgId, viewerToken, otherToken, otherOrgId
const AS_OF = '2027-06-30'
const IMPORT = 'account_code,amount\n1110,500.00\n1120,25.00\n1210,20.00\n2210,30.00\n2110,40.00\n3110,60.00\n4310,415.00'

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const res = await createOrg(server, { organizationName: `CO Parish ${RUN_ID}`, name: 'CO Admin',
    email: `co_admin_${RUN_ID}@openchurch.test`, password: 'cutover-pw-1' }, '10.63.1.1')
  expect(res.status).toBe(201)
  token = res.body.token; orgId = res.body.user.organization.id
  const imp = await request(server).post('/api/finance/ledger/import').set('Authorization', `Bearer ${token}`)
    .send({ csv: IMPORT, as_of: AS_OF })
  expect(imp.status).toBe(201)
  // A new parish carries sample rows too; the 'old system' file mirrors
  // every live balance so a true penny match is possible.
  const sum = await request(server).get(`/api/finance/summary?start=1900-01-01&end=${AS_OF}`).set('Authorization', `Bearer ${token}`)
  // R414-2: every active chart account must be listed, so start from the
  // template (all active accounts at 0.00) and fill in the live balances.
  const tpl = await request(server).get('/api/finance/cutover/template').set('Authorization', `Bearer ${token}`)
  expect(tpl.status).toBe(200)
  const bal = new Map(tpl.text.trim().split(/\r?\n/).slice(1).map(l => l.split(',')))
  for (const a of sum.body.accounts) bal.set(a.code, a.total)
  BOOKS = 'account_code,amount\n' + [...bal].map(([c, v]) => `${c},${v}`).join('\n')
  for (const l of IMPORT.split('\n').slice(1)) expect(BOOKS).toContain(l)
  const email = `co_viewer_${RUN_ID}@openchurch.test`
  const { rows } = await pool.query(`INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
    VALUES ($1, $2, 'x', 'CO Viewer', 'viewer') RETURNING id, token_version`, [orgId, email])
  viewerToken = signToken({ userId: rows[0].id, organizationId: orgId, email, name: 'CO Viewer', role: 'viewer', tv: rows[0].token_version ?? 1 })
  const other = await createOrg(server, { organizationName: `CO Other ${RUN_ID}`, name: 'CO Other',
    email: `co_other_${RUN_ID}@openchurch.test`, password: 'cutover-pw-2' }, '10.63.1.2')
  otherToken = other.body.token; otherOrgId = other.body.user.organization.id
}, 60_000)

afterAll(async () => {
  for (const id of [orgId, otherOrgId]) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

const post = (path, body, tok = token) => request(server).post(`/api/finance/cutover/${path}`).set('Authorization', `Bearer ${tok}`).send(body)
const line = (sb, k) => sb.lines.find(l => l.key === k)
const ledgerCount = async () => (await pool.query('SELECT COUNT(*)::int n FROM ochr_ledger_entries WHERE organization_id = $1', [orgId])).rows[0].n

describe('five-line scoreboard', () => {
  it('a complete penny match on every line is cutover ready, and writes nothing to the ledger', async () => {
    const before = await ledgerCount()
    const res = await post('scoreboard', { csv: BOOKS, as_of: AS_OF })
    expect(res.status).toBe(200)
    expect(res.body.lines.map(l => [l.key, l.status, l.variance_cents])).toEqual([
      ['cash', 'match', 0], ['receivables', 'match', 0], ['deposits', 'match', 0],
      ['payables', 'match', 0], ['trial_balance', 'match', 0]])
    expect(line(res.body, 'cash').openchurch_cents).toBe(52500)
    expect(res.body.cutover_ready).toBe(true)
    expect(await ledgerCount()).toBe(before)
  })

  it('an unreadable row makes every line incomplete with no variance — never $0.00', async () => {
    const res = await post('scoreboard', { csv: BOOKS + '\n9999,12.345', as_of: AS_OF })
    expect(res.status).toBe(200)
    expect(res.body.complete).toBe(false)
    expect(res.body.cutover_ready).toBe(false)
    for (const l of res.body.lines) {
      expect(l.status, l.key).toBe('incomplete')
      expect(l.variance_cents, l.key).toBeNull()
      expect(l.old_system_cents, l.key).toBeNull()
    }
  })

  it('a line the old file says nothing about is missing (UNKNOWN), not a match', async () => {
    const res = await post('scoreboard', { csv: BOOKS.replace('\n1210,20.00', ''), as_of: AS_OF })
    expect(line(res.body, 'receivables')).toMatchObject({ status: 'missing', variance_cents: null })
    expect(res.body.cutover_ready).toBe(false)
  })

  it('variances that net to zero inside a line are still a mismatch', async () => {
    const res = await post('scoreboard', { csv: BOOKS.replace('1110,500.00', '1110,500.01').replace('1120,25.00', '1120,24.99'), as_of: AS_OF })
    expect(line(res.body, 'cash')).toMatchObject({ status: 'mismatch', variance_cents: 0, mismatched_accounts: 2 })
    expect(line(res.body, 'trial_balance').status).toBe('mismatch')
    expect(res.body.cutover_ready).toBe(false)
  })

  it('is scoped to the caller\'s parish', async () => {
    const res = await post('scoreboard', { csv: BOOKS, as_of: AS_OF }, otherToken)
    expect(line(res.body, 'cash')).toMatchObject({ openchurch_cents: 0, status: 'mismatch' })
  })

  it('rejects a viewer and a bad request', async () => {
    expect((await post('scoreboard', { csv: BOOKS, as_of: AS_OF }, viewerToken)).status).toBe(403)
    expect((await post('scoreboard', { csv: BOOKS })).status).toBe(400)
    expect((await post('scoreboard', { csv: 'code,amount\n1110,1', as_of: AS_OF })).status).toBe(400)
  })
})

describe('accountant export', () => {
  it('exports the scoreboard and trial balance as CSV', async () => {
    const res = await post('export', { csv: BOOKS, as_of: AS_OF })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.headers['content-disposition']).toMatch(/cutover-scoreboard-2027-06-30\.csv/)
    expect(res.text).toMatch(/"cutover_ready","yes"/)
    expect(res.text).toMatch(/"cash","match","525\.00","525\.00","0\.00"/)
    expect(res.text).toMatch(/"1110","Cash — Operating","Cash & Bank","500\.00","500\.00","0\.00","yes"/)
  })

  it('an incomplete export says UNKNOWN, never 0.00, for old side and variance', async () => {
    const res = await post('export', { csv: BOOKS + '\nabc,1', as_of: AS_OF })
    expect(res.text).toMatch(/"cutover_ready","no"/)
    expect(res.text).toMatch(/"cash","incomplete","525\.00","UNKNOWN","UNKNOWN","UNKNOWN"/)
    expect(res.text).not.toMatch(/"incomplete","[^"]*","[^"]*","0\.00"/)
    expect(res.text).toMatch(/"unreadable_line","error"/)
  })
})

describe('accountant sign-off (append-only)', () => {
  it('is refused unless the scoreboard is cutover ready', async () => {
    const res = await post('signoffs', { csv: BOOKS + '\nabc,1', as_of: AS_OF, accountant_name: 'Pat CPA', signed_on: '2027-07-01' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('cutover_not_ready')
  })

  it('records name and date when ready, lists it, and refuses edits and deletes', async () => {
    const res = await post('signoffs', { csv: BOOKS, as_of: AS_OF, accountant_name: '  Pat CPA ', signed_on: '2027-07-01' })
    expect(res.status).toBe(201)
    expect(res.body.accountant_name).toBe('Pat CPA')
    const list = await request(server).get('/api/finance/cutover/signoffs').set('Authorization', `Bearer ${token}`)
    expect(list.body.signoffs.map(s => s.accountant_name)).toEqual(['Pat CPA'])
    await expect(pool.query('UPDATE ochr_cutover_signoffs SET accountant_name = $2 WHERE id = $1', [res.body.id, 'X'])).rejects.toThrow(/append-only/)
    await expect(pool.query('DELETE FROM ochr_cutover_signoffs WHERE id = $1', [res.body.id])).rejects.toThrow(/append-only/)
  })

  it('requires a name and date; viewers cannot read or record; other parishes see none', async () => {
    expect((await post('signoffs', { csv: BOOKS, as_of: AS_OF, accountant_name: '', signed_on: '2027-07-01' })).status).toBe(400)
    expect((await post('signoffs', { csv: BOOKS, as_of: AS_OF, accountant_name: 'Pat' })).status).toBe(400)
    expect((await request(server).get('/api/finance/cutover/signoffs').set('Authorization', `Bearer ${viewerToken}`)).status).toBe(403)
    expect((await post('signoffs', { csv: BOOKS, as_of: AS_OF, accountant_name: 'Pat', signed_on: '2027-07-01' }, viewerToken)).status).toBe(403)
    const o = await request(server).get('/api/finance/cutover/signoffs').set('Authorization', `Bearer ${otherToken}`)
    expect(o.body.signoffs).toEqual([])
  })

  it('the parish\'s own deletion still cascades through the append-only guard', async () => {
    const tmp = await createOrg(server, { organizationName: `CO Tmp ${RUN_ID}`, name: 'Tmp',
      email: `co_tmp_${RUN_ID}@openchurch.test`, password: 'cutover-pw-3' }, '10.63.1.3')
    const id = tmp.body.user.organization.id
    const uid = tmp.body.user.id
    await pool.query(`INSERT INTO ochr_cutover_signoffs (organization_id, as_of, accountant_name, signed_on, scoreboard, recorded_by) VALUES ($1, '2027-06-30', 'T', '2027-07-01', '{}', $2)`, [id, uid])
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id])
    expect((await pool.query('SELECT COUNT(*)::int n FROM ochr_cutover_signoffs WHERE organization_id = $1', [id])).rows[0].n).toBe(0)
  })
})

describe('R414-2: every expected account must be listed', () => {
  it('Cash with 1110 and 1120: omitting a zero-balance 1120 is not a match', () => {
    const chart = [{ code: '1110', rollup_group: 'Cash & Bank', active: true }, { code: '1120', rollup_group: 'Cash & Bank', active: true }]
    const accounts = [{ code: '1110', name: 'Checking', openchurch_cents: 50000, old_system_cents: 50000, in_old_file: true, variance_cents: 0 }]
    const { lines } = scoreLines(accounts, chart, [])
    const cash = lines.find(l => l.key === 'cash')
    expect(cash.status).toBe('missing')
    expect(cash.not_in_file).toEqual(['1120'])
    expect(cash.variance_cents).toBeNull()
  })

  it('through the API: a file that omits zero-balance 1120 is not cutover ready', async () => {
    const tmp = await createOrg(server, { organizationName: `CO Zero ${RUN_ID}`, name: 'Zero',
      email: `co_zero_${RUN_ID}@openchurch.test`, password: 'cutover-pw-4' }, '10.63.1.4')
    const t = tmp.body.token
    const tpl = await request(server).get('/api/finance/cutover/template').set('Authorization', `Bearer ${t}`)
    const sum = await request(server).get(`/api/finance/summary?start=1900-01-01&end=${AS_OF}`).set('Authorization', `Bearer ${t}`)
    const bal = new Map(tpl.text.trim().split(/\r?\n/).slice(1).map(l => l.split(',')))
    for (const a of sum.body.accounts) bal.set(a.code, a.total)
    expect(bal.get('1120')).toBe('0.00')
    const full = 'account_code,amount\n' + [...bal].map(([c, v]) => `${c},${v}`).join('\n')
    const ok = await request(server).post('/api/finance/cutover/scoreboard').set('Authorization', `Bearer ${t}`).send({ csv: full, as_of: AS_OF })
    expect(ok.body.lines.find(l => l.key === 'cash').status).toBe('match')
    const omit = full.split('\n').filter(l => !l.startsWith('1120,')).join('\n')
    const res = await request(server).post('/api/finance/cutover/scoreboard').set('Authorization', `Bearer ${t}`).send({ csv: omit, as_of: AS_OF })
    const cash = res.body.lines.find(l => l.key === 'cash')
    expect(cash.status).toBe('missing')
    expect(cash.not_in_file).toContain('1120')
    expect(res.body.cutover_ready).toBe(false)
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [tmp.body.user.organization.id])
  })
})

describe('Atlas P2-2: an unreadable OpenChurch total is incomplete, not $0.00', () => {
  it('marks the line incomplete with null amounts', () => {
    expect(toCents('n/a')).toBeNull()
    const chart = [{ code: '1110', rollup_group: 'Cash & Bank', active: true }]
    const accounts = [{ code: '1110', openchurch_cents: null, old_system_cents: 0, in_old_file: true, variance_cents: null }]
    const r = scoreLines(accounts, chart, [])
    const cash = r.lines.find(l => l.key === 'cash')
    expect(cash.status).toBe('incomplete')
    expect(cash.openchurch_cents).toBeNull()
    expect(cash.variance_cents).toBeNull()
    expect(r.complete).toBe(false)
  })
})

describe('Atlas P1-2: recorded_by is required and tied to this parish', () => {
  it('refuses a null recorder, a recorder from another parish, and deleting the recorder', async () => {
    const { rows: [u] } = await pool.query('SELECT id FROM ochr_users WHERE organization_id = $1 AND role = $2 LIMIT 1', [orgId, 'admin'])
    const ins = (rb, org = orgId) => pool.query(`INSERT INTO ochr_cutover_signoffs (organization_id, as_of, accountant_name, signed_on, scoreboard, recorded_by) VALUES ($1, '2027-06-30', 'X', '2027-07-01', '{}', $2)`, [org, rb])
    await expect(ins(null)).rejects.toThrow(/null value/)
    const { rows: [ou] } = await pool.query('SELECT id FROM ochr_users WHERE organization_id = $1 LIMIT 1', [otherOrgId])
    await expect(ins(ou.id)).rejects.toThrow(/foreign key/)
    await ins(u.id)
    await expect(pool.query('DELETE FROM ochr_users WHERE id = $1', [u.id])).rejects.toThrow(/foreign key|violates/)
    const { rows: [fk] } = await pool.query(`SELECT confdeltype FROM pg_constraint WHERE conname = 'ochr_cutover_signoffs_recorder_fk'`)
    expect(fk.confdeltype).toBe('r')
  })
})

const wait = ms => new Promise(r => setTimeout(r, ms))
const signoff = (name) => request(server).post('/api/finance/cutover/signoffs').set('Authorization', `Bearer ${token}`)
  .send({ csv: BOOKS, as_of: AS_OF, accountant_name: name, signed_on: '2027-07-02' }).then(r => r)
// Run `fn` while a transaction holds exactly the locks a sign-off for orgId holds.
async function whileSignoffHolds(fn) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const got = await acquireSignoffLocks(c, orgId)
    expect(got.ok).toBe(true)
    return await fn(got)
  } finally { await c.query('COMMIT').catch(() => {}); c.release() }
}
// Start a write on its own connection; report whether it finished.
function startWrite(sql, params) {
  const st = { done: false, err: null }
  st.p = pool.query(sql, params).then(() => { st.done = true }, e => { st.err = e; st.done = true })
  return st
}

describe('R414-1: concurrent writes cannot make the attestation stale (no test hook in the router)', () => {
  let dioceseId
  beforeAll(async () => {
    const { rows: [d] } = await pool.query(`INSERT INTO ochr_organizations (name, slug, org_type) VALUES ($1, $2, 'diocese') RETURNING id`, [`CO Diocese ${RUN_ID}`, `co-diocese-${RUN_ID}`.toLowerCase()])
    dioceseId = d.id
    await pool.query(`INSERT INTO ochr_diocese_affiliations (diocese_org_id, parish_org_id, status) VALUES ($1, $2, 'active')`, [dioceseId, orgId])
  })
  afterAll(async () => {
    await pool.query('DELETE FROM ochr_diocese_affiliations WHERE parish_org_id = $1', [orgId]).catch(() => {})
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [dioceseId]).catch(() => {})
  })

  it('sign-off keys are one sorted list: (finance, org) EXCLUSIVE, (chart, template) and (chart, diocese) SHARED', () => {
    expect(signoffKeys(7, 3)).toEqual([
      { ns: FINANCE_LOCK_NS, key: 7, exclusive: true },
      { ns: CHART_LOCK_NS, key: 0, exclusive: false },
      { ns: CHART_LOCK_NS, key: 3, exclusive: false },
      { ns: CHART_LOCK_NS, key: 7, exclusive: false }])
    expect(signoffKeys(7, null).map(k => k.key)).toEqual([7, 0, 7])
  })

  it('a ledger write while a sign-off holds its locks waits until it commits', async () => {
    let w
    await whileSignoffHolds(async () => {
      w = startWrite(`INSERT INTO ochr_ledger_entries (organization_id, entry_date, account_code, amount, memo, source_type)
        VALUES ($1, '2027-06-01', '1110', 1.00, 'race', 'manual')`, [orgId])
      await wait(300)
      expect(w.done).toBe(false)
    })
    await w.p
    expect(w.err).toBeNull()
    expect((await signoff('Race Check')).status).toBe(409)   // books moved after it
    await pool.query(`DELETE FROM ochr_ledger_entries WHERE organization_id = $1 AND memo = 'race'`, [orgId])
  })

  it('a ledger write committed before the locks are granted is seen, so the sign-off is 409', async () => {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`INSERT INTO ochr_ledger_entries (organization_id, entry_date, account_code, amount, memo, source_type)
        VALUES ($1, '2027-06-01', '1110', 1.00, 'race2', 'manual')`, [orgId])
      const p = signoff('Race Two')
      await wait(300)
      await c.query('COMMIT')   // the sign-off was polling on our shared key
      expect((await p).status).toBe(409)
    } finally { c.release() }
    await pool.query(`DELETE FROM ochr_ledger_entries WHERE organization_id = $1 AND memo = 'race2'`, [orgId])
  })

  it('chart change during sign-off: diocesan, template and affiliation writes wait for the sign-off', async () => {
    let dio, tpl, aff
    await whileSignoffHolds(async (got) => {
      expect(got.dioceseOrgId).toBe(dioceseId)
      dio = startWrite(`INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group)
        VALUES ($1, '1197', 'Dio probe', 'asset', 'Cash')`, [dioceseId])
      tpl = startWrite(`UPDATE ochr_coa_accounts SET sort_order = sort_order WHERE organization_id IS NULL AND code = '1110'`)
      aff = startWrite(`UPDATE ochr_diocese_affiliations SET grant_level = grant_level WHERE parish_org_id = $1`, [orgId])
      await wait(300)
      expect({ dio: dio.done, tpl: tpl.done, aff: aff.done }).toEqual({ dio: false, tpl: false, aff: false })
    })
    await Promise.all([dio.p, tpl.p, aff.p])
    expect([dio.err, tpl.err, aff.err]).toEqual([null, null, null])
    await pool.query(`DELETE FROM ochr_coa_accounts WHERE organization_id = $1 AND code = '1197'`, [dioceseId])
  })

  it('chart change during sign-off: an uncommitted diocesan account is waited for and then seen (409, not a stale 201)', async () => {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group)
        SELECT $1, '1198', 'Dio new cash', acct_type, rollup_group FROM ochr_coa_accounts
         WHERE organization_id IS NULL AND code = '1110'`, [dioceseId])
      const p = signoff('Chart Race')
      await wait(300)
      await c.query('COMMIT')
      const res = await p
      expect(res.status).toBe(409)   // 1198 is now an active account the old file omits
    } finally { c.release() }
    await pool.query(`DELETE FROM ochr_coa_accounts WHERE organization_id = $1 AND code = '1198'`, [dioceseId])
  })

  it('no deadlock in the Atlas cycle (writer A row X, sign-off pending, writer B row Y, A wants Y)', async () => {
    const { rows } = await pool.query(`INSERT INTO ochr_ledger_entries (organization_id, entry_date, account_code, amount, memo, source_type)
      VALUES ($1, '2027-06-01', '1110', 1.00, 'dl', 'manual'), ($1, '2027-06-01', '1110', -1.00, 'dl', 'manual') RETURNING id`, [orgId])
    const [x, y] = rows.map(r => r.id)
    const a = await pool.connect(), b = await pool.connect()
    try {
      await a.query('BEGIN'); await b.query('BEGIN')
      await a.query(`UPDATE ochr_ledger_entries SET memo = 'dl-a' WHERE id = $1`, [x])
      const s = signoff('Deadlock Probe')
      await wait(150)
      const bw = b.query(`UPDATE ochr_ledger_entries SET memo = 'dl-b' WHERE id = $1`, [y])
      await Promise.race([bw, wait(1000).then(() => { throw new Error('writer B queued behind the sign-off') })])
      const aw = a.query(`UPDATE ochr_ledger_entries SET memo = 'dl-a' WHERE id = $1`, [y])
      await wait(100)
      await b.query('COMMIT')
      await aw
      await a.query('COMMIT')
      const res = await s
      expect([201, 409, 503]).toContain(res.status)
    } finally { await a.query('ROLLBACK').catch(() => {}); await b.query('ROLLBACK').catch(() => {}); a.release(); b.release() }
    await pool.query(`DELETE FROM ochr_ledger_entries WHERE organization_id = $1 AND memo LIKE 'dl%'`, [orgId])
  })

  it('a sign-off records its snapshot marker and time; bounded lock wait returns 503, never a hang', async () => {
    const ok = await signoff('Snapshot Check')
    expect(ok.status).toBe(201)
    expect(ok.body.snapshot_marker).toMatch(/^\d+:\d+:/)
    expect(Number.isNaN(Date.parse(ok.body.snapshot_at))).toBe(false)
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`UPDATE ochr_coa_accounts SET sort_order = sort_order WHERE organization_id = $1`, [dioceseId])
      await c.query('SELECT pg_advisory_xact_lock($1, 0)', [CHART_LOCK_NS])   // a template edit in flight
      const t0 = Date.now()
      const busy = await signoff('Busy Check')
      expect(busy.status).toBe(503)
      expect(busy.body.code).toBe('cutover_busy')
      expect(Date.now() - t0).toBeLessThan(6000)
    } finally { await c.query('ROLLBACK'); c.release() }
  })
})

describe('append-only cascade exception is narrow', () => {
  it('a nested (trigger-fired) DELETE while the parish still exists is refused', async () => {
    const { rows: [u] } = await pool.query('SELECT id FROM ochr_users WHERE organization_id = $1 AND role = $2 LIMIT 1', [otherOrgId, 'admin'])
    await pool.query(`INSERT INTO ochr_cutover_signoffs (organization_id, as_of, accountant_name, signed_on, scoreboard, recorded_by) VALUES ($1, '2027-06-30', 'N', '2027-07-01', '{}', $2)`, [otherOrgId, u.id])
    const c = await pool.connect()
    try {
      await c.query('CREATE TEMP TABLE nested_probe (org INTEGER)')
      await c.query(`CREATE FUNCTION pg_temp.nested_probe_del() RETURNS trigger AS $$
        BEGIN DELETE FROM ochr_cutover_signoffs WHERE organization_id = NEW.org; RETURN NEW; END $$ LANGUAGE plpgsql`)
      await c.query('CREATE TRIGGER nested_probe_t AFTER INSERT ON nested_probe FOR EACH ROW EXECUTE FUNCTION pg_temp.nested_probe_del()')
      await expect(c.query('INSERT INTO nested_probe VALUES ($1)', [otherOrgId])).rejects.toThrow(/append-only/)
    } finally { await c.query('DROP TABLE IF EXISTS nested_probe').catch(() => {}); c.release() }
    expect((await pool.query('SELECT COUNT(*)::int n FROM ochr_cutover_signoffs WHERE organization_id = $1', [otherOrgId])).rows[0].n).toBe(1)
  })
})

// R414-3 (TARS): chart-owner keys are explicit. Global template rows
// (organization_id NULL) always lock (chart, 0); diocesan rows lock
// (chart, D) only — never the diocese's (finance, D) data key; parish rows
// lock only their own (finance, P) SHARED key. Proven through pg_locks.
async function advisoryLocksOf(c) {
  const { rows } = await c.query(`SELECT classid::int AS ns, objid::int AS key, mode FROM pg_locks
     WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid IN ($1, $2) ORDER BY 1, 2`,
  [FINANCE_LOCK_NS, CHART_LOCK_NS])
  return rows
}
// Run sql in its own transaction; resolves with the advisory locks it holds
// after the statement, then rolls back (nothing persists).
function heldWrite(sql, params, { lockTimeout } = {}) {
  const st = { done: false, err: null, locks: null }
  st.p = (async () => {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      if (lockTimeout) await c.query(`SET LOCAL lock_timeout = '${lockTimeout}'`)
      await c.query(sql, params)
      st.locks = await advisoryLocksOf(c)
    } catch (e) { st.err = e } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); st.done = true }
  })()
  return st
}

describe('R414-3: explicit chart-owner keys and no deadlock with row locks held', () => {
  let dioceseId, probeId
  const TPL = [{ ns: CHART_LOCK_NS, key: 0, mode: 'ExclusiveLock' }]
  beforeAll(async () => {
    const { rows: [d] } = await pool.query(`INSERT INTO ochr_organizations (name, slug, org_type) VALUES ($1, $2, 'diocese') RETURNING id`, [`CO Dio3 ${RUN_ID}`, `co-dio3-${RUN_ID}`.toLowerCase()])
    dioceseId = d.id
    await pool.query(`UPDATE ochr_diocese_affiliations SET status = 'inactive' WHERE parish_org_id = ANY($1)`, [[orgId, otherOrgId]]).catch(() => {})
    await pool.query(`DELETE FROM ochr_diocese_affiliations WHERE parish_org_id = ANY($1)`, [[orgId, otherOrgId]])
    await pool.query(`INSERT INTO ochr_diocese_affiliations (diocese_org_id, parish_org_id, status) VALUES ($1, $2, 'active'), ($1, $3, 'active')`, [dioceseId, orgId, otherOrgId])
    const { rows: [p] } = await pool.query(`INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, active)
      VALUES (NULL, 'R4143', 'R414-3 template probe', 'asset', 'Cash', false) RETURNING id`)
    probeId = p.id
  })
  afterAll(async () => {
    await pool.query('DELETE FROM ochr_coa_accounts WHERE id = $1', [probeId]).catch(() => {})
    await pool.query(`DELETE FROM ochr_coa_accounts WHERE organization_id = $1`, [dioceseId]).catch(() => {})
    await pool.query('DELETE FROM ochr_diocese_affiliations WHERE diocese_org_id = $1', [dioceseId]).catch(() => {})
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [dioceseId]).catch(() => {})
  })

  const tplWrites = {
    INSERT: [`INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, active)
      VALUES (NULL, 'R4144', 'tpl insert probe', 'asset', 'Cash', false)`, []],
    UPDATE: [`UPDATE ochr_coa_accounts SET name = name WHERE id = $1`, () => [probeId]],
    DELETE: [`DELETE FROM ochr_coa_accounts WHERE id = $1`, () => [probeId]],
  }
  for (const [op, [sql, params]] of Object.entries(tplWrites)) {
    it(`global-template ${op} waits for an in-progress sign-off, then holds exactly (chart, 0) EXCLUSIVE`, async () => {
      const args = typeof params === 'function' ? params() : params
      let w
      await whileSignoffHolds(async (got) => {
        expect(got.keys).toContainEqual({ ns: CHART_LOCK_NS, key: 0, exclusive: false })
        w = heldWrite(sql, args)
        await wait(300)
        expect(w.done).toBe(false)
      })
      await w.p
      expect(w.err).toBeNull()
      expect(w.locks).toEqual(TPL)
    })
    it(`global-template ${op} during a sign-off is bounded (55P03), never a hang`, async () => {
      const args = typeof params === 'function' ? params() : params
      let w
      await whileSignoffHolds(async () => {
        const t0 = Date.now()
        w = heldWrite(sql, args, { lockTimeout: '300ms' })
        await w.p
        expect(Date.now() - t0).toBeLessThan(3000)
      })
      expect(w.err?.code).toBe('55P03')
    })
  }

  it('a diocesan chart row takes only (chart, D) — not the diocese data key; a parish row only (finance, P) SHARED', async () => {
    const dio = heldWrite(`INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group)
      VALUES ($1, '1196', 'Dio key probe', 'asset', 'Cash')`, [dioceseId])
    await dio.p
    expect(dio.err).toBeNull()
    expect(dio.locks).toEqual([{ ns: CHART_LOCK_NS, key: dioceseId, mode: 'ExclusiveLock' }])
    const par = heldWrite(`INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group)
      VALUES ($1, '1196', 'Parish key probe', 'asset', 'Cash')`, [orgId])
    await par.p
    expect(par.err).toBeNull()
    expect(par.locks).toEqual([{ ns: FINANCE_LOCK_NS, key: orgId, mode: 'ShareLock' }])
  })

  it("a diocese's own sign-off excludes an edit of its own chart", async () => {
    const c = await pool.connect()
    let w
    try {
      await c.query('BEGIN')
      const got = await acquireSignoffLocks(c, dioceseId)
      expect(got.ok).toBe(true)
      w = heldWrite(`UPDATE ochr_coa_accounts SET name = name WHERE organization_id IS NULL AND code = '1110'`)
      const dw = heldWrite(`INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group)
        VALUES ($1, '1195', 'Dio self probe', 'asset', 'Cash')`, [dioceseId], { lockTimeout: '300ms' })
      await dw.p
      expect(dw.err?.code).toBe('55P03')
    } finally { await c.query('COMMIT').catch(() => {}); c.release() }
    await w.p
    expect(w.err).toBeNull()
  })

  it('bounded concurrency: diocesan chart edits (writer already holding parish row locks) vs looping parish sign-offs — no deadlock, all finish', async () => {
    const { rows } = await pool.query(`INSERT INTO ochr_ledger_entries (organization_id, entry_date, account_code, amount, memo, source_type)
      VALUES ($1, '2027-06-01', '1110', 1.00, 'r4143', 'manual'), ($2, '2027-06-01', '1110', 1.00, 'r4143', 'manual') RETURNING id`, [orgId, otherOrgId])
    const [rowA, rowB] = rows.map(r => r.id)
    const errors = []
    const stopAt = Date.now() + 2500
    const signoffLoop = async (pid) => {
      let ok = 0
      while (Date.now() < stopAt) {
        const c = await pool.connect()
        try {
          await c.query('BEGIN')
          const got = await acquireSignoffLocks(c, pid, { budgetMs: 1500 })
          if (got.ok) { ok++; await wait(20) }
          await c.query('COMMIT')
        } catch (e) { errors.push(e); await c.query('ROLLBACK').catch(() => {}) } finally { c.release() }
      }
      return ok
    }
    const chartWriter = async (i) => {
      let ok = 0
      while (Date.now() < stopAt) {
        const c = await pool.connect()
        try {
          await c.query('BEGIN')
          await c.query(`SET LOCAL lock_timeout = '3s'`)
          // Already holding other row locks (parish ledger rows, both parishes) ...
          // Lock both rows in a deterministic (id) order first. A bare UPDATE ... WHERE id = ANY($1)
          // takes row locks in scan order, so two writers can lock the rows in opposite orders and
          // deadlock with EACH OTHER (40P01) — a writer-vs-writer race this test is not about.
          // The array order still alternates per writer; the lock order no longer depends on it.
          const ids = i % 2 ? [rowB, rowA] : [rowA, rowB]
          await c.query(`SELECT id FROM ochr_ledger_entries WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids])
          await c.query(`UPDATE ochr_ledger_entries SET memo = memo WHERE id = ANY($1)`, [ids])
          // ... then the diocesan chart change and a template touch.
          await c.query(`UPDATE ochr_coa_accounts SET name = name WHERE organization_id = $1`, [dioceseId])
          await c.query(`INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, active)
            VALUES ($1, $2, 'r4143 conc', 'asset', 'Cash', false)`, [dioceseId, `R43${i}${ok}`])
          await c.query('COMMIT'); ok++
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); if (e.code !== '55P03') errors.push(e) } finally { c.release() }
      }
      return ok
    }
    const t0 = Date.now()
    const [s1, s2, w1, w2] = await Promise.all([signoffLoop(orgId), signoffLoop(otherOrgId), chartWriter(1), chartWriter(2)])
    expect(Date.now() - t0).toBeLessThan(12000)
    expect(errors.map(e => `${e.code} ${e.message}`)).toEqual([])   // in particular no 40P01
    expect(s1 + s2).toBeGreaterThan(0)
    expect(w1 + w2).toBeGreaterThan(0)
    await pool.query(`DELETE FROM ochr_ledger_entries WHERE memo = 'r4143'`)
    await pool.query(`DELETE FROM ochr_coa_accounts WHERE organization_id = $1 AND name = 'r4143 conc'`, [dioceseId])
  }, 30_000)
})
