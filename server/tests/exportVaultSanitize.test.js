// Export / backup / restore must not carry reusable credential material,
// and must not drop parish content whose key happens to look secret.
//
// CLAIM. Secret columns are an explicit per-table list. That list is
// applied to live rows and to vault snapshot rows by their source table.
// It is not applied inside jsonb documents (form answers, import rows).
//
// WHAT WOULD MAKE THESE FAIL
//   - the export or its gzipped backup bytes contain a sentinel token
//   - a freshly captured vault row still stores the live token
//   - restore writes the historical token back onto ochr_clients
//   - the old calendar or swap URL answers again after restore
//   - a form answer, payment_ref, CSV import key, or sacramental
//     meta_attributes value is missing or changed, including harmless
//     keys token_count, input_tokens, and stripe_token_id
//   - a secret-shaped column is neither denied nor allowlisted with a reason
//   - a base-vs-head export diff changes anything other than a denied
//     secret column or a usage counter the old top-level regex omitted
//     (input_tokens, output_tokens, diagnosis_tokens)
//   - the calendar token minted after restore equals the one minted before delete
//   - a live row still carries password_hash, token_version, calendar_token,
//     or swap_token (the export's top-level column strip was removed)
//   - ochr_push_subscriptions or ochr_notification_log is no longer excluded,
//     so a seeded device key or notification body appears in the export

import { gzipSync, gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { buildOrgExport, EXCLUDED_TABLES } from '../src/services/orgExport.js'
import { SECRET_COLUMNS, ALLOWED_SECRETISH, sanitizeSnapshot } from '../src/services/credentialSanitize.js'
import { captureAndDelete } from '../src/vault/index.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'

let server
let token
let orgId
let userId
let memberId
let entryId
let formId
let donationId
let importRowId
let sacramentId
let preDeleteCalendar

// Sentinels must not be substrings of each other. `hist-cal-…` contains
// `cal-…`, and a leak of only the historical value would then look like
// the live token had leaked too.
const CAL = `livecalendar-${RUN_ID}`
const SWAP = `liveswap-${RUN_ID}`
const HIST_CAL = `oldcalendar-${RUN_ID}`
const HIST_SWAP = `oldswap-${RUN_ID}`
const CODE = `code-${RUN_ID}-bearer`
const CODE_HASH = `codehash-${RUN_ID}-bearer`
const PW_HASH = `pw-hash-${RUN_ID}-bearer`
const RESET_HASH = `reset-hash-${RUN_ID}-bearer`
const KIOSK = `kiosk-${RUN_ID}-bearer`
const AI_KEY = `aikey-${RUN_ID}-bearer`
const TV = `tv-${RUN_ID}-bearer`
const NOTES = `Notes survive sanitizing ${RUN_ID}`
const NAME = `Synthetic Member ${RUN_ID}`
const RESPONDENT = `Respondent ${RUN_ID}`
const PAYMENT_REF = `payref-${RUN_ID}`
const ANSWERS = {
  secret_santa: `santa-gift-${RUN_ID}`,
  secretary_email: `office-${RUN_ID}@example.com`,
  hashtag: `#parish-${RUN_ID}`,
  'Envelope Hash': `env-${RUN_ID}`,
  tokens_redeemed: '4',
  pepperoni_or_cheese: 'cheese',
  token_count: '3',
  input_tokens: '128',
  stripe_token_id: `tok-ans-${RUN_ID}`,
}
const META = {
  godparents: ['Ana Example', 'Luis Example'],
  secret_santa: `meta-santa-${RUN_ID}`,
  token_count: '2',
  input_tokens: '64',
  stripe_token_id: `tok-meta-${RUN_ID}`,
}
const IMPORT_RAW = {
  secret_santa: `csv-santa-${RUN_ID}`,
  secretary_email: `csv-office-${RUN_ID}@example.com`,
  hashtag: `#csv-${RUN_ID}`,
  'Envelope Hash': `csv-env-${RUN_ID}`,
  'Security Code': `csv-code-${RUN_ID}`,
  tokens_redeemed: '9',
  pepperoni_or_cheese: 'pepperoni',
}
const IMPORT_MAPPING = { 'Envelope Hash': 'notes', 'Security Code': 'skip' }
const AUDIT_IN = 128
const AUDIT_OUT = 64
const LEDGER_IN = 32
const LEDGER_OUT = 16
const DIAGNOSIS_TOKENS = { input: 9, output: 4 }
const LEGACY_CAL = `legacycal-${RUN_ID}`
const LEGACY_SWAP = `legacyswap-${RUN_ID}`
const LEGACY_NAME = `Legacy Root ${RUN_ID}`
const LEGACY_NOTES = `Legacy notes ${RUN_ID}`
// Usage counters the pre-fix top-level regex omitted and this branch exports.
// The base-vs-head diff must see exactly these head-only paths.
const PUSH_ENDPOINT = `https://push.example.invalid/synthetic/${RUN_ID}`
const PUSH_P256 = `p256-${RUN_ID}`
const PUSH_AUTH = `pushauth-${RUN_ID}`
const NOTIFY_SUBJECT = `Notify subject ${RUN_ID}`
const NOTIFY_BODY = `Notify body canary ${RUN_ID}`
const HEAD_ONLY_COUNTERS = [
  'ochr_ai_audit.input_tokens',
  'ochr_ai_audit.output_tokens',
  'ochr_ai_ledger.input_tokens',
  'ochr_ai_ledger.output_tokens',
  'ochr_support_tickets.diagnosis_tokens',
]

const SENTINELS = [CAL, SWAP, HIST_CAL, HIST_SWAP, CODE, CODE_HASH, PW_HASH, RESET_HASH, KIOSK, AI_KEY, TV]

const auth = () => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const org = await request(server).post('/api/auth/signup')
    .set('X-Forwarded-For', '10.88.21.7')
    .send({
      organizationName: `Vault Sanitize Parish ${RUN_ID}`,
      name: 'Synthetic Admin',
      email: `vault_sanitize_${RUN_ID}@example.com`,
      password: 'vault-sanitize-pw-1',
    })
  expect(org.status).toBe(201)
  token = org.body.token
  orgId = org.body.user.organization.id
  userId = org.body.user.id

  const member = await request(server).post('/api/clients').set(auth()).send({
    name: NAME,
    email: `member_${RUN_ID}@example.com`,
    notes: NOTES,
  })
  expect(member.status).toBe(201)
  memberId = member.body.id

  // The pre-delete token has to be one the link route actually minted.
  // A SQL sentinel would still differ from a later mint that is a pure
  // function of the member id, and that mutation would stay green.
  const minted = await request(server).get(`/api/calendar-sync/link/${memberId}`).set(auth())
  expect(minted.status).toBe(200)
  preDeleteCalendar = minted.body.token
  expect(preDeleteCalendar).toBeTruthy()
  expect(preDeleteCalendar).not.toBe(CAL)
  expect(preDeleteCalendar).not.toBe(HIST_CAL)

  await pool.query(
    `UPDATE ochr_clients SET swap_token = $1 WHERE id = $2 AND organization_id = $3`,
    [SWAP, memberId, orgId],
  )

  const del = await request(server).delete(`/api/clients/${memberId}`).set(auth())
  expect(del.status).toBe(204)

  const { rows } = await pool.query(
    `SELECT id, snapshot FROM ochr_vault_entries
      WHERE organization_id = $1 AND kind = 'member' AND entity_id = $2
      ORDER BY id DESC LIMIT 1`,
    [orgId, String(memberId)],
  )
  expect(rows).toHaveLength(1)
  entryId = rows[0].id

  // A row written before sanitizing-at-capture. The live delete above is
  // the new path; this UPDATE is the historical path export and restore
  // still have to survive. No migration rewrites these rows.
  const snapshot = rows[0].snapshot
  // Canaries sit on the table that actually owns the column. A client
  // row does not have password_hash; stuffing it there would not be the
  // row shape capture writes, and a per-table denylist would correctly
  // leave it alone.
  snapshot.roots[0].calendar_token = HIST_CAL
  snapshot.roots[0].swap_token = HIST_SWAP
  snapshot.cascaded = snapshot.cascaded || []
  snapshot.cascaded.push({
    table: 'ochr_checkins',
    row: {
      organization_id: orgId,
      person_name: `Synthetic Child ${RUN_ID}`,
      security_code: CODE,
      security_code_hash: CODE_HASH,
    },
  })
  snapshot.cascaded.push({
    table: 'ochr_users',
    row: {
      organization_id: orgId,
      name: `Synthetic User ${RUN_ID}`,
      email: `user_${RUN_ID}@example.com`,
      password_hash: PW_HASH,
      token_version: TV,
    },
  })
  snapshot.cascaded.push({
    table: 'ochr_password_reset_tokens',
    row: { token_hash: RESET_HASH },
  })
  snapshot.cascaded.push({
    table: 'ochr_organizations',
    row: { kiosk_token: KIOSK, ai_api_key_enc: AI_KEY, name: `Kiosk Org ${RUN_ID}` },
  })

  const form = await request(server).post('/api/forms').set(auth()).send({
    title: `Signup sheet ${RUN_ID}`,
    status: 'open',
    fields: [
      { id: 'secret_santa', type: 'short_text', label: 'Secret Santa' },
      { id: 'secretary_email', type: 'email', label: 'Secretary email' },
      { id: 'hashtag', type: 'short_text', label: 'Hashtag' },
      { id: 'Envelope Hash', type: 'short_text', label: 'Envelope number' },
      { id: 'tokens_redeemed', type: 'short_text', label: 'Tokens redeemed' },
      { id: 'pepperoni_or_cheese', type: 'short_text', label: 'Pizza' },
    ],
  })
  expect(form.status).toBe(201)
  formId = form.body.id
  await pool.query(
    `INSERT INTO ochr_form_responses
       (form_id, organization_id, answers, respondent_name)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [formId, orgId, JSON.stringify(ANSWERS), RESPONDENT],
  )

  const gift = await request(server).post('/api/donations').set(auth()).send({
    donor_name: `Synthetic Donor ${RUN_ID}`,
    amount: 123.45,
    notes: `Gift note ${RUN_ID}`,
  })
  expect(gift.status).toBe(201)
  donationId = gift.body.id
  await pool.query(
    `UPDATE ochr_donations SET payment_ref = $1 WHERE id = $2 AND organization_id = $3`,
    [PAYMENT_REF, donationId, orgId],
  )

  const batch = await pool.query(
    `INSERT INTO ochr_import_batches
       (organization_id, kind, source_name, headers, mapping)
     VALUES ($1, 'members', $2, $3::jsonb, $4::jsonb)
     RETURNING id`,
    [
      orgId,
      `synthetic-${RUN_ID}.csv`,
      JSON.stringify(Object.keys(IMPORT_RAW)),
      JSON.stringify(IMPORT_MAPPING),
    ],
  )
  const imported = await pool.query(
    `INSERT INTO ochr_import_rows (organization_id, batch_id, row_no, raw)
     VALUES ($1, $2, 1, $3::jsonb)
     RETURNING id`,
    [orgId, batch.rows[0].id, JSON.stringify(IMPORT_RAW)],
  )
  importRowId = imported.rows[0].id

  const sacrament = await pool.query(
    `INSERT INTO ochr_sacramental_records
       (organization_id, type, notes, meta_attributes, member_name)
     VALUES ($1, 'baptism', $2, $3::jsonb, $4)
     RETURNING id`,
    [orgId, `Register note ${RUN_ID}`, JSON.stringify(META), `Synthetic Member ${RUN_ID}`],
  )
  sacramentId = sacrament.rows[0].id

  await pool.query(
    `INSERT INTO ochr_ai_audit
       (application, environment, organization_id, request_id, event, input_tokens, output_tokens)
     VALUES ('openchurch', 'test', $1, $2, 'synthetic.usage', $3, $4)`,
    [orgId, `req-audit-${RUN_ID}`, AUDIT_IN, AUDIT_OUT],
  )
  await pool.query(
    `INSERT INTO ochr_ai_ledger
       (reservation_id, application, environment, organization_id, request_id,
        capability, reserved_micros, input_tokens, output_tokens)
     VALUES ($1, 'openchurch', 'test', $2, $3, 'synthetic', 1, $4, $5)`,
    [`res-${RUN_ID}`, orgId, `req-ledger-${RUN_ID}`, LEDGER_IN, LEDGER_OUT],
  )
  await pool.query(
    `INSERT INTO ochr_support_tickets (organization_id, description, diagnosis_tokens)
     VALUES ($1, $2, $3::jsonb)`,
    [orgId, `Synthetic ticket ${RUN_ID}`, JSON.stringify(DIAGNOSIS_TOKENS)],
  )

  await pool.query(
    `INSERT INTO ochr_push_subscriptions
       (organization_id, user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4, $5)`,
    [orgId, userId, PUSH_ENDPOINT, PUSH_P256, PUSH_AUTH],
  )
  await pool.query(
    `INSERT INTO ochr_notification_log
       (organization_id, user_id, recipient_email, notification_type, subject, body, status)
     VALUES ($1, $2, $3, 'synthetic', $4, $5, 'stubbed')`,
    [orgId, userId, `notify_${RUN_ID}@example.com`, NOTIFY_SUBJECT, NOTIFY_BODY],
  )

  await pool.query(
    `INSERT INTO ochr_vault_entries
       (organization_id, kind, entity_table, entity_id, label, snapshot, retention_until)
     VALUES ($1, 'member', 'ochr_clients', $2, $3, $4::jsonb, CURRENT_DATE + 30)`,
    [
      orgId,
      `legacy-root-${RUN_ID}`,
      LEGACY_NAME,
      JSON.stringify({
        root: {
          name: LEGACY_NAME,
          notes: LEGACY_NOTES,
          calendar_token: LEGACY_CAL,
          swap_token: LEGACY_SWAP,
        },
      }),
    ],
  )
  await pool.query(
    `UPDATE ochr_vault_entries SET snapshot = $2::jsonb WHERE id = $1 AND organization_id = $3`,
    [entryId, JSON.stringify(snapshot), orgId],
  )
}, 120_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

function artifactText(dump) {
  const gz = gzipSync(Buffer.from(JSON.stringify(dump), 'utf8'))
  return gunzipSync(gz).toString('utf8')
}

// jsonb does not preserve key order. Fidelity is the keys and the exact
// string values, which is what a parish would lose if a key were dropped.
function expectExactMap(actual, expected) {
  expect(actual).toEqual(expected)
  for (const [k, v] of Object.entries(expected)) {
    if (typeof v === 'string') expect(actual[k]).toBe(v)
    else expect(actual[k]).toEqual(v)
  }
}

// Column names only. A token buried in a JSON string or a URL is out of
// scope for this denylist; the classification test does not scan values.
// `_enc` is a suffix so foo_enc is flagged even when the stem is innocuous.
// Bare `key` also matches source_key, donor_key, and item_key; those are
// allowlisted. It does not match endpoint, p256dh, or auth.
const SECRETISH = /(password|secret|token|pepper|hash|security_code|api_key|private_key|jwt|bearer|signing_key|pin|otp|credential|cookie|authorization|passcode|access_key|access_code|magic_link|feed_passcode|ics_key|session_id|webhook_url|nonce|salt|key)/i

function isSecretishName(name) {
  return SECRETISH.test(name) || /_enc$/i.test(name)
}

function isDenied(table, column) {
  return Boolean(SECRET_COLUMNS[table]?.includes(column))
}

const SECRET_NAMES = new Set(Object.values(SECRET_COLUMNS).flat())
const USAGE_COUNTERS = new Set(['input_tokens', 'output_tokens', 'diagnosis_tokens'])

function legacyProject(_table, row, generated) {
  // Top-level column strip on main, before this branch. No recursion.
  const oldSensitive = /(password|secret|token|pepper|hash|security_code)/i
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (oldSensitive.test(k)) continue
    if (generated?.has(k)) continue
    out[k] = v
  }
  return out
}

function sameLeaf(a, b) {
  if (Object.is(a, b)) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return false
}

function isPlain(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
    && !(typeof Buffer !== 'undefined' && Buffer.isBuffer(v))
}

function diffNodes(base, head, path, problems, counters) {
  if (sameLeaf(base, head)) return
  if (Array.isArray(base) || Array.isArray(head)) {
    if (!Array.isArray(base) || !Array.isArray(head)) {
      problems.push(`${path} type differs`)
      return
    }
    if (base.length !== head.length) {
      problems.push(`${path} length ${base.length} vs ${head.length}`)
      return
    }
    for (let i = 0; i < base.length; i++) diffNodes(base[i], head[i], `${path}[${i}]`, problems, counters)
    return
  }
  if (isPlain(base) && isPlain(head)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(head)])
    for (const k of keys) {
      if (SECRET_NAMES.has(k)) continue
      const child = `${path}.${k}`
      const inBase = Object.prototype.hasOwnProperty.call(base, k)
      const inHead = Object.prototype.hasOwnProperty.call(head, k)
      // The pre-fix regex omitted these usage counts. Head exports them.
      // Any other head-only key is a failure.
      if (USAGE_COUNTERS.has(k) && inHead && !inBase) {
        counters.push(child)
        continue
      }
      if (!inBase) { problems.push(`${child} only in head`); continue }
      if (!inHead) { problems.push(`${child} only in base`); continue }
      diffNodes(base[k], head[k], child, problems, counters)
    }
    return
  }
  problems.push(`${path} value differs`)
}

describe.sequential('vault snapshots do not export, back up, or restore bearer tokens', () => {
  it('a freshly captured member snapshot does not store the live tokens', async () => {
    // The historical UPDATE above replaced the stored snapshot. Re-read
    // is the wrong probe for write-time. This assertion uses a second
    // member so the capture path is observed before any injection.
    const made = await request(server).post('/api/clients').set(auth()).send({
      name: `Second Synthetic ${RUN_ID}`,
    })
    expect(made.status).toBe(201)
    const secondId = made.body.id
    await pool.query(
      `UPDATE ochr_clients SET calendar_token = $1, swap_token = $2 WHERE id = $3`,
      [CAL, SWAP, secondId],
    )
    const del = await request(server).delete(`/api/clients/${secondId}`).set(auth())
    expect(del.status).toBe(204)

    const { rows } = await pool.query(
      `SELECT snapshot::text AS snapshot FROM ochr_vault_entries
        WHERE organization_id = $1 AND kind = 'member' AND entity_id = $2`,
      [orgId, String(secondId)],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].snapshot).not.toContain(CAL)
    expect(rows[0].snapshot).not.toContain(SWAP)
    expect(rows[0].snapshot).toContain(`Second Synthetic ${RUN_ID}`)
  })

  it('the admin export and the gzipped backup bytes omit credential material nested in snapshots', async () => {
    const digestSrc = readFileSync(new URL('../src/services/backupDigest.js', import.meta.url), 'utf8')
    expect(digestSrc).toMatch(/buildOrgExport/)

    const dump = await buildOrgExport(orgId)
    const text = artifactText(dump)
    for (const sentinel of [...SENTINELS, preDeleteCalendar, LEGACY_CAL, LEGACY_SWAP]) {
      expect(text, sentinel).not.toContain(sentinel)
    }
    expect(text).toContain(NAME)
    expect(text).toContain(NOTES)

    // Top-level column strip. Snapshot sanitizing alone would still leave
    // password_hash on the live user row. Removing that one `continue`
    // must fail this file, not only portabilityExport.
    for (const user of dump.tables.ochr_users || []) {
      expect(user).not.toHaveProperty('password_hash')
      expect(user).not.toHaveProperty('token_version')
    }
    for (const member of dump.tables.ochr_clients || []) {
      expect(member).not.toHaveProperty('calendar_token')
      expect(member).not.toHaveProperty('swap_token')
    }
    for (const checkin of dump.tables.ochr_checkins || []) {
      expect(checkin).not.toHaveProperty('security_code')
      expect(checkin).not.toHaveProperty('security_code_hash')
    }

    const viaHttp = await request(server).get('/api/organization/export').set(auth())
    expect(viaHttp.status).toBe(200)
    const body = typeof viaHttp.body === 'object' && viaHttp.body.format
      ? JSON.stringify(viaHttp.body)
      : viaHttp.text
    for (const sentinel of [...SENTINELS, preDeleteCalendar, LEGACY_CAL, LEGACY_SWAP]) {
      expect(body).not.toContain(sentinel)
    }

    const audit = dump.tables.ochr_ai_audit.find(r => r.request_id === `req-audit-${RUN_ID}`)
    expect(Number(audit.input_tokens)).toBe(AUDIT_IN)
    expect(Number(audit.output_tokens)).toBe(AUDIT_OUT)
    const ledger = dump.tables.ochr_ai_ledger.find(r => r.reservation_id === `res-${RUN_ID}`)
    expect(Number(ledger.input_tokens)).toBe(LEDGER_IN)
    expect(Number(ledger.output_tokens)).toBe(LEDGER_OUT)
    const ticket = dump.tables.ochr_support_tickets.find(r => r.description === `Synthetic ticket ${RUN_ID}`)
    expect(ticket.diagnosis_tokens).toEqual(DIAGNOSIS_TOKENS)
  })

  it('a legacy singular-root snapshot does not export its calendar or swap token', async () => {
    const dump = await buildOrgExport(orgId)
    const entry = dump.tables.ochr_vault_entries.find(r => r.entity_id === `legacy-root-${RUN_ID}`)
    expect(entry).toBeTruthy()
    expect(entry.snapshot.root).not.toHaveProperty('calendar_token')
    expect(entry.snapshot.root).not.toHaveProperty('swap_token')
    expect(entry.snapshot.root.name).toBe(LEGACY_NAME)
    expect(entry.snapshot.root.notes).toBe(LEGACY_NOTES)
    const text = artifactText(dump)
    expect(text).not.toContain(LEGACY_CAL)
    expect(text).not.toContain(LEGACY_SWAP)
    expect(text).toContain(LEGACY_NOTES)
  })

  it('every secret-shaped column is denied or allowlisted with a reason', async () => {
    const { rows } = await pool.query(`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name LIKE 'ochr\\_%' ESCAPE '\\'`)
    const present = new Set(rows.map(r => `${r.table_name}.${r.column_name}`))
    const unclassified = []
    const both = []
    for (const r of rows) {
      if (!isSecretishName(r.column_name)) continue
      const key = `${r.table_name}.${r.column_name}`
      const denied = isDenied(r.table_name, r.column_name)
      const reason = ALLOWED_SECRETISH[key]
      if (denied && reason) both.push(key)
      else if (!denied && !(typeof reason === 'string' && reason.trim())) unclassified.push(key)
    }
    expect(both, `both denied and allowlisted: ${both.join(', ')}`).toEqual([])
    expect(unclassified, `unclassified: ${unclassified.join(', ')}`).toEqual([])

    for (const [table, cols] of Object.entries(SECRET_COLUMNS)) {
      for (const col of cols) {
        expect(present.has(`${table}.${col}`), `${table}.${col} is not a column`).toBe(true)
      }
    }
    for (const [key, reason] of Object.entries(ALLOWED_SECRETISH)) {
      expect(present.has(key), `${key} is not a column`).toBe(true)
      expect(typeof reason === 'string' && reason.trim().length > 0).toBe(true)
    }

    const tables = new Set(rows.map(r => r.table_name))
    for (const name of EXCLUDED_TABLES) {
      expect(tables.has(name), `${name} is excluded from export but is not a table`).toBe(true)
    }
    const pushCols = new Set(
      rows.filter(r => r.table_name === 'ochr_push_subscriptions').map(r => r.column_name),
    )
    expect(pushCols.has('auth')).toBe(true)
    expect(pushCols.has('p256dh')).toBe(true)
    expect(EXCLUDED_TABLES.has('ochr_push_subscriptions')).toBe(true)
    expect(EXCLUDED_TABLES.has('ochr_notification_log')).toBe(true)
  })

  it('push subscriptions and the notification log stay out of the export and the backup', async () => {
    expect(EXCLUDED_TABLES.has('ochr_push_subscriptions')).toBe(true)
    expect(EXCLUDED_TABLES.has('ochr_notification_log')).toBe(true)

    const dump = await buildOrgExport(orgId)
    expect(dump.tables).not.toHaveProperty('ochr_push_subscriptions')
    expect(dump.tables).not.toHaveProperty('ochr_notification_log')
    expect(dump.counts).not.toHaveProperty('ochr_push_subscriptions')
    expect(dump.counts).not.toHaveProperty('ochr_notification_log')

    const objectText = JSON.stringify(dump)
    const backupText = artifactText(dump)
    for (const canary of [PUSH_ENDPOINT, PUSH_P256, PUSH_AUTH, NOTIFY_SUBJECT, NOTIFY_BODY]) {
      expect(objectText, canary).not.toContain(canary)
      expect(backupText, canary).not.toContain(canary)
    }
  })

  it('form answers, payment_ref, and CSV import keys survive the export and the gunzipped backup', async () => {
    const dump = await buildOrgExport(orgId)
    const text = artifactText(dump)
    const parsed = JSON.parse(text)

    const response = parsed.tables.ochr_form_responses.find(r => r.respondent_name === RESPONDENT)
    expectExactMap(response.answers, ANSWERS)

    const gift = parsed.tables.ochr_donations.find(r => r.id === donationId)
    expect(gift.payment_ref).toBe(PAYMENT_REF)
    expect(gift.donor_name).toBe(`Synthetic Donor ${RUN_ID}`)
    expect(Number(gift.amount)).toBe(123.45)

    const imported = parsed.tables.ochr_import_rows.find(r => r.id === importRowId)
    expectExactMap(imported.raw, IMPORT_RAW)
    const batch = parsed.tables.ochr_import_batches.find(r => r.id === imported.batch_id)
    expectExactMap(batch.mapping, IMPORT_MAPPING)
    expect(batch.headers).toEqual(Object.keys(IMPORT_RAW))

    const register = parsed.tables.ochr_sacramental_records.find(r => r.id === sacramentId)
    expectExactMap(register.meta_attributes, META)
    expect(register.notes).toBe(`Register note ${RUN_ID}`)
  })

  it('form answers survive vault capture and restore byte-for-byte', async () => {
    const del = await request(server).delete(`/api/forms/${formId}`).set(auth())
    expect(del.status).toBe(204)

    const { rows } = await pool.query(
      `SELECT id, snapshot FROM ochr_vault_entries
        WHERE organization_id = $1 AND kind = 'form' AND entity_id = $2`,
      [orgId, String(formId)],
    )
    expect(rows).toHaveLength(1)
    const captured = rows[0].snapshot.cascaded.find(c => c.table === 'ochr_form_responses')
    expectExactMap(captured.row.answers, ANSWERS)

    const dumped = await buildOrgExport(orgId)
    const fromExport = JSON.parse(artifactText(dumped))
    const exportedSnap = fromExport.tables.ochr_vault_entries.find(r => r.id === rows[0].id)
    const exportedAnswers = exportedSnap.snapshot.cascaded.find(c => c.table === 'ochr_form_responses')
    expectExactMap(exportedAnswers.row.answers, ANSWERS)

    const res = await request(server).post(`/api/vault/${rows[0].id}/restore`).set(auth())
    expect(res.status).toBe(200)
    const { rows: back } = await pool.query(
      `SELECT answers FROM ochr_form_responses
        WHERE form_id = $1 AND organization_id = $2 AND respondent_name = $3`,
      [formId, orgId, RESPONDENT],
    )
    expect(back).toHaveLength(1)
    expectExactMap(back[0].answers, ANSWERS)
  })

  it('payment_ref survives vault capture and restore byte-for-byte', async () => {
    const captured = await captureAndDelete({
      kind: 'donation', id: donationId, orgId, reason: 'synthetic fidelity',
    })
    const { rows } = await pool.query(
      `SELECT snapshot FROM ochr_vault_entries WHERE id = $1 AND organization_id = $2`,
      [captured.entry_id, orgId],
    )
    expect(rows[0].snapshot.roots[0].payment_ref).toBe(PAYMENT_REF)
    expect(Number(rows[0].snapshot.roots[0].amount)).toBe(123.45)

    const dumped = await buildOrgExport(orgId)
    const fromExport = JSON.parse(artifactText(dumped))
    const exported = fromExport.tables.ochr_vault_entries.find(r => r.id === captured.entry_id)
    expect(exported.snapshot.roots[0].payment_ref).toBe(PAYMENT_REF)

    const res = await request(server).post(`/api/vault/${captured.entry_id}/restore`).set(auth())
    expect(res.status).toBe(200)
    const { rows: back } = await pool.query(
      `SELECT payment_ref, donor_name, amount FROM ochr_donations WHERE id = $1 AND organization_id = $2`,
      [donationId, orgId],
    )
    expect(back[0].payment_ref).toBe(PAYMENT_REF)
    expect(back[0].donor_name).toBe(`Synthetic Donor ${RUN_ID}`)
    expect(Number(back[0].amount)).toBe(123.45)
  })

  it('CSV import row keys survive vault capture and restore byte-for-byte', async () => {
    // Import rows are not a protected delete. Capture still has to keep
    // them when they ride along in a snapshot, which is the same
    // sanitizeSnapshot the form capture just used. 'Security Code' is a
    // parish header, not a column, and this PR does not strip it.
    const { rows: live } = await pool.query(
      `SELECT * FROM ochr_import_rows WHERE id = $1 AND organization_id = $2`,
      [importRowId, orgId],
    )
    expect(live).toHaveLength(1)
    const row = live[0]
    await pool.query(
      `DELETE FROM ochr_import_rows WHERE id = $1 AND organization_id = $2`,
      [importRowId, orgId],
    )

    const sanitized = sanitizeSnapshot('ochr_clients', {
      roots: [{ id: memberId, organization_id: orgId, name: NAME }],
      cascaded: [{ table: 'ochr_import_rows', row }],
      relinks: [],
    })
    expectExactMap(sanitized.cascaded[0].row.raw, IMPORT_RAW)

    const { rows: entries } = await pool.query(
      `SELECT id, snapshot FROM ochr_vault_entries
        WHERE id = $1 AND organization_id = $2`,
      [entryId, orgId],
    )
    const snapshot = entries[0].snapshot
    snapshot.cascaded = snapshot.cascaded || []
    snapshot.cascaded.push(sanitized.cascaded[0])
    await pool.query(
      `UPDATE ochr_vault_entries SET snapshot = $2::jsonb WHERE id = $1 AND organization_id = $3`,
      [entries[0].id, JSON.stringify(snapshot), orgId],
    )

    const dumped = await buildOrgExport(orgId)
    const fromExport = JSON.parse(artifactText(dumped))
    const exported = fromExport.tables.ochr_vault_entries.find(r => r.id === entries[0].id)
    const exportedRow = exported.snapshot.cascaded.find(c => c.table === 'ochr_import_rows')
    expectExactMap(exportedRow.row.raw, IMPORT_RAW)
  })

  it('sacramental metadata and harmless token-shaped JSON keys survive vault capture and restore', async () => {
    const { rows: live } = await pool.query(
      `SELECT * FROM ochr_sacramental_records WHERE id = $1 AND organization_id = $2`,
      [sacramentId, orgId],
    )
    expect(live).toHaveLength(1)
    expectExactMap(live[0].meta_attributes, META)
    await pool.query(
      `DELETE FROM ochr_sacramental_records WHERE id = $1 AND organization_id = $2`,
      [sacramentId, orgId],
    )

    const sanitized = sanitizeSnapshot('ochr_clients', {
      roots: [{ id: memberId, organization_id: orgId, name: NAME }],
      cascaded: [{ table: 'ochr_sacramental_records', row: live[0] }],
      relinks: [],
    })
    expectExactMap(sanitized.cascaded[0].row.meta_attributes, META)

    const { rows: entries } = await pool.query(
      `SELECT id, snapshot FROM ochr_vault_entries WHERE id = $1 AND organization_id = $2`,
      [entryId, orgId],
    )
    const snapshot = entries[0].snapshot
    snapshot.cascaded = snapshot.cascaded || []
    snapshot.cascaded.push(sanitized.cascaded[0])
    await pool.query(
      `UPDATE ochr_vault_entries SET snapshot = $2::jsonb WHERE id = $1 AND organization_id = $3`,
      [entryId, JSON.stringify(snapshot), orgId],
    )

    const dumped = await buildOrgExport(orgId)
    const fromExport = JSON.parse(artifactText(dumped))
    const exported = fromExport.tables.ochr_vault_entries.find(r => r.id === entryId)
    const exportedRow = exported.snapshot.cascaded.find(c => c.table === 'ochr_sacramental_records')
    expectExactMap(exportedRow.row.meta_attributes, META)
  })

  it('restore puts the member back without the old calendar or swap token', async () => {
    const stored = await pool.query(
      `SELECT snapshot::text AS snapshot FROM ochr_vault_entries WHERE id = $1`,
      [entryId],
    )
    expect(stored.rows[0].snapshot).toContain(HIST_CAL)
    expect(stored.rows[0].snapshot).toContain(HIST_SWAP)

    const res = await request(server).post(`/api/vault/${entryId}/restore`).set(auth())
    expect(res.status).toBe(200)
    expect(res.body.restored.records).toBeGreaterThanOrEqual(1)

    const { rows } = await pool.query(
      `SELECT name, notes, calendar_token, swap_token FROM ochr_clients WHERE id = $1 AND organization_id = $2`,
      [memberId, orgId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe(NAME)
    expect(rows[0].notes).toBe(NOTES)
    expect(rows[0].calendar_token).toBeNull()
    expect(rows[0].swap_token).toBeNull()

    const staleCal = await request(server).get(`/api/calendar-sync/${HIST_CAL}.ics`)
    expect(staleCal.status).toBe(404)
    const staleSwap = await request(server).get(`/api/swap/by-token/${HIST_SWAP}`)
    expect(staleSwap.status).toBe(404)

    const link = await request(server).get(`/api/calendar-sync/link/${memberId}`).set(auth())
    expect(link.status).toBe(200)
    expect(link.body.token).toBeTruthy()
    expect(link.body.token).not.toBe(preDeleteCalendar)
    expect(link.body.token).not.toBe(HIST_CAL)
    expect(link.body.token).not.toBe(CAL)

    const { rows: after } = await pool.query(
      `SELECT calendar_token FROM ochr_clients WHERE id = $1`,
      [memberId],
    )
    expect(after[0].calendar_token).toBe(link.body.token)
    expect(after[0].calendar_token).not.toBe(preDeleteCalendar)
    expect(after[0].calendar_token).not.toBe(HIST_CAL)

    const { rows: imported } = await pool.query(
      `SELECT raw FROM ochr_import_rows WHERE id = $1 AND organization_id = $2`,
      [importRowId, orgId],
    )
    expect(imported).toHaveLength(1)
    expectExactMap(imported[0].raw, IMPORT_RAW)

    const { rows: register } = await pool.query(
      `SELECT meta_attributes, notes FROM ochr_sacramental_records
        WHERE id = $1 AND organization_id = $2`,
      [sacramentId, orgId],
    )
    expect(register).toHaveLength(1)
    expect(register[0].notes).toBe(`Register note ${RUN_ID}`)
    expectExactMap(register[0].meta_attributes, META)
  })

  it('a whole-export base-vs-head diff changes only denylisted secrets or usage counters', async () => {
    const head = await buildOrgExport(orgId)
    const base = await buildOrgExport(orgId, { projectRow: legacyProject })
    const problems = []
    const counters = []
    diffNodes(base.tables, head.tables, 'tables', problems, counters)
    diffNodes(base.organization, head.organization, 'organization', problems, counters)
    diffNodes(base.counts, head.counts, 'counts', problems, counters)
    expect(problems, problems.slice(0, 30).join('\n')).toEqual([])
    const seen = new Set(counters.map(p => {
      const match = p.match(/tables\.(ochr_[a-z0-9_]+)\[\d+\]\.([a-z0-9_]+)$/)
      return match ? `${match[1]}.${match[2]}` : p
    }))
    expect([...seen].sort()).toEqual([...HEAD_ONLY_COUNTERS].sort())
    expect(head.format).toBe(base.format)
    expect(head.version).toBe(base.version)
  })
})
