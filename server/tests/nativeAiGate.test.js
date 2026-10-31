// Native AI admission. Web requests are unchanged. A native shell is
// excluded unless OC_NATIVE_AI_MODE is exactly consent-required, and even
// then nothing is sent before that person's agreement. Synthetic parishes only.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'

vi.mock('../src/ai/gate.js', async () => {
  const actual = await vi.importActual('../src/ai/gate.js')
  const dispatch = vi.fn(async (args) => {
    if (args && args.nativeShell === true) return actual.dispatch(args)
    throw actual.aiRefusal('ai_unavailable')
  })
  return { ...actual, dispatch }
})

import { dispatch } from '../src/ai/gate.js'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { NATIVE_AI_ARCHIVE_TOKEN, NATIVE_AI_DISCLOSURE_VERSION, configuredNativeAiMode, effectiveNativeAiMode, supportTriageAllowed } from '../src/ai/nativeAiMode.js'
import { viewerMayRead } from '../src/middleware/viewerScope.js'
import { AI_INVENTORY } from '../../client/src/native/aiInventory.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const NATIVE = 'OpenChurchNative/1.0'
const PW = 'native-ai-pw-123'
const savedMode = process.env.OC_NATIVE_AI_MODE

let server
const orgs = []
const auth = (t) => ({ Authorization: `Bearer ${t}` })

function setMode(value) {
  if (value == null) delete process.env.OC_NATIVE_AI_MODE
  else process.env.OC_NATIVE_AI_MODE = value
}

async function signup(tag, ip) {
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', ip)
    .send({ organizationName: `Native AI ${tag} ${RUN_ID}`, name: `Admin ${tag}`, email: `nai_${tag}_${RUN_ID}@example.com`, password: PW })
  expect(res.status).toBe(201)
  orgs.push(res.body.user.organization.id)
  return { token: res.body.token, userId: res.body.user.id, orgId: res.body.user.organization.id }
}

async function addUser(admin, role, tag, ip) {
  const email = `nai_${tag}_${RUN_ID}@example.com`
  const created = await request(server).post('/api/users').set(auth(admin.token))
    .send({ name: tag, email, password: PW, role })
  expect(created.status).toBe(201)
  const login = await request(server).post('/api/auth/login').set('X-Forwarded-For', ip)
    .send({ email, password: PW })
  expect(login.status).toBe(200)
  return { token: login.body.token, userId: created.body.id }
}

let a, b, staff, viewer

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  a = await signup('a', '10.128.1.1')
  b = await signup('b', '10.128.1.2')
  staff = await addUser(a, 'staff', 'staff', '10.128.1.3')
  viewer = await addUser(a, 'viewer', 'viewer', '10.128.1.4')
}, 90_000)

afterAll(async () => {
  setMode(savedMode)
  for (const id of orgs) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

afterEach(() => {
  setMode(savedMode)
  dispatch.mockClear()
})

const native = (req, ceiling = 'consent-required') =>
  req
    .set('User-Agent', ceiling === 'consent-required' ? `${NATIVE} ${NATIVE_AI_ARCHIVE_TOKEN}` : NATIVE)
    .set('X-OC-Native-Ai-Ceiling', ceiling)
const seenDisclosure = { disclosure_version: NATIVE_AI_DISCLOSURE_VERSION }

async function openRows(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT disclosure_version FROM ochr_native_ai_consents
      WHERE organization_id = $1 AND user_id = $2 AND withdrawn_at IS NULL`,
    [orgId, userId])
  return rows
}

describe('platform-ai-switch, server-dispatch-chokepoint, d16c-chancery, and daily-verse', () => {
  it('keeps the operator stop, checks native admission inside dispatch, and does not invent a chancery or verse send', () => {
    const mode = readFileSync(join(SRC, 'ai', 'nativeAiMode.js'), 'utf8')
    const gate = readFileSync(join(SRC, 'ai', 'gate.js'), 'utf8')
    // The comment names the existing switch so the two are not confused.
    // This module does not read or write that table.
    expect(mode).toContain('not the platform AI stop')
    expect(mode).not.toMatch(/\b(FROM|INTO|UPDATE|TABLE)\s+ochr_platform_ai_switch\b/i)
    expect(gate).toContain('assertAiRunning')
    expect(gate).toContain('assertNativeShellAdmission')
    expect(readFileSync(join(SRC, 'routes', 'aiSwitch.js'), 'utf8')).toContain('ochr_platform_ai_switch')

    const callers = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (name.endsWith('.js')) {
          const text = readFileSync(full, 'utf8')
          if (/from ['"][^'"]*ai\/gate\.js['"]/.test(text) && text.includes('dispatch(')) {
            callers.push(full.slice(SRC.length + 1))
          }
        }
      }
    }
    walk(SRC)
    expect(callers.sort()).toEqual(['routes/ai.js', 'routes/assistant.js', 'routes/supportTickets.js'])
    for (const file of callers) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).toContain('nativeShell')
    }
    expect(readFileSync(join(SRC, 'routes', 'supportTickets.js'), 'utf8')).toContain('supportTriageAllowed')

    const routes = []
    const walkRoutes = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (name.endsWith('.js') && readFileSync(full, 'utf8').includes('chancery_message_draft_v1')) routes.push(name)
      }
    }
    walkRoutes(join(SRC, 'routes'))
    expect(routes).toEqual([])
    expect(readFileSync(join(SRC, 'ai', 'policy.js'), 'utf8')).toContain('chancery_message_draft_v1')
    expect(readFileSync(join(SRC, 'services', 'dailyVerse.js'), 'utf8')).not.toContain('ai/gate')
    expect(readFileSync(join(SRC, 'routes', 'dailyVerse.js'), 'utf8')).not.toContain('ai/gate')

    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    for (const row of AI_INVENTORY.filter(r => r.suite === 'server')) {
      expect(src, row.id).toContain(row.id)
    }
  })
})

describe('mode and viewer read', () => {
  it('defaults to excluded and lets a viewer read only the agreement route', () => {
    expect(configuredNativeAiMode({})).toBe('excluded')
    expect(configuredNativeAiMode({ OC_NATIVE_AI_MODE: 'excluded' })).toBe('excluded')
    expect(configuredNativeAiMode({ OC_NATIVE_AI_MODE: 'yes' })).toBe('excluded')
    expect(configuredNativeAiMode({ OC_NATIVE_AI_MODE: 'consent-required' })).toBe('consent-required')
    expect(effectiveNativeAiMode('consent-required', 'excluded')).toBe('excluded')
    expect(effectiveNativeAiMode('excluded', 'consent-required')).toBe('excluded')
    expect(effectiveNativeAiMode('consent-required', 'consent-required')).toBe('consent-required')
    expect(effectiveNativeAiMode('consent-required', undefined)).toBe('excluded')
    expect(supportTriageAllowed({ native: false, mode: 'excluded', consentActive: false })).toBe(true)
    expect(supportTriageAllowed({ native: true, mode: 'excluded', consentActive: true })).toBe(false)
    expect(supportTriageAllowed({ native: true, mode: 'consent-required', consentActive: false })).toBe(false)
    expect(supportTriageAllowed({ native: true, mode: 'consent-required', consentActive: true })).toBe(true)
    expect(viewerMayRead('/api/ai/native-access')).toBe(true)
    expect(viewerMayRead('/api/ai/generations')).toBe(false)
    expect(viewerMayRead('/api/ai')).toBe(false)
  })
})

describe('server-dispatch-chokepoint admission', () => {
  it('refuses a native send inside dispatch before any provider, and allows one after agreement', async () => {
    setMode(null)
    await expect(dispatch({
      orgId: a.orgId, capabilityId: 'parish_assistant_v1', actorUserId: a.userId,
      nativeShell: true, system: 's', messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toMatchObject({ code: 'ai_excluded', refusal: true })

    setMode('consent-required')
    await expect(dispatch({
      orgId: a.orgId, capabilityId: 'parish_assistant_v1', actorUserId: a.userId,
      nativeShell: true, nativeCeiling: 'excluded', system: 's', messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toMatchObject({ code: 'ai_excluded', refusal: true })
    await expect(dispatch({
      orgId: a.orgId, capabilityId: 'parish_assistant_v1', actorUserId: a.userId,
      nativeShell: true, nativeCeiling: 'consent-required', system: 's', messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toMatchObject({ code: 'ai_consent_required', refusal: true })

    const agreed = await native(request(server).post('/api/ai/native-access')).set(auth(a.token)).send(seenDisclosure)
    expect(agreed.status).toBe(201)
    expect(agreed.body.consent.disclosure_version).toBe(NATIVE_AI_DISCLOSURE_VERSION)
    await expect(dispatch({
      orgId: a.orgId, capabilityId: 'parish_assistant_v1', actorUserId: a.userId,
      nativeShell: true, nativeCeiling: 'consent-required', system: 's', messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toMatchObject({ code: 'ai_key_required', refusal: true })
  })
})

describe('agreement rows', () => {
  it('records one open row for the signed-in person, ignores a body user id, and hides it from another parish', async () => {
    setMode('consent-required')
    const spoof = await native(request(server).post('/api/ai/native-access')).set(auth(staff.token))
      .send({ user_id: a.userId, ...seenDisclosure })
    expect(spoof.status).toBe(201)
    expect(spoof.body.consent_active).toBe(true)
    expect(spoof.body.consent.consented_at).toBeTruthy()
    expect(await openRows(a.orgId, staff.userId)).toHaveLength(1)
    expect(await openRows(a.orgId, a.userId)).toHaveLength(1)

    const other = await native(request(server).get('/api/ai/native-access')).set(auth(b.token))
    expect(other.status).toBe(200)
    expect(other.body.consent).toBeNull()
    expect(other.body.consent_active).toBe(false)

    const webWrite = await request(server).post('/api/ai/native-access').set(auth(b.token)).send({})
    expect(webWrite.status).toBe(403)
    expect(webWrite.body.code).toBe('not_native')
    expect(await openRows(b.orgId, b.userId)).toHaveLength(0)

    const webRead = await request(server).get('/api/ai/native-access').set(auth(a.token))
    expect(webRead.body).toMatchObject({ applies: false, mode: 'web', consent_active: false, consent: null })
  })

  it('replaces an older disclosure in one transaction and withdrawal ends the open row', async () => {
    setMode('consent-required')
    await pool.query(
      `INSERT INTO ochr_native_ai_consents (organization_id, user_id, disclosure_version)
       VALUES ($1, $2, 'old-draft')`,
      [a.orgId, viewer.userId])
    const before = await native(request(server).get('/api/ai/native-access')).set(auth(viewer.token))
    expect(before.body.consent_active).toBe(false)

    const stale = await native(request(server).post('/api/ai/native-access')).set(auth(viewer.token))
      .send({ disclosure_version: 'screen-a' })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('ai_disclosure_mismatch')
    expect(stale.body.required_disclosure_version).toBe(NATIVE_AI_DISCLOSURE_VERSION)
    const stillOld = await pool.query(
      `SELECT disclosure_version, withdrawn_at FROM ochr_native_ai_consents
        WHERE organization_id = $1 AND user_id = $2`,
      [a.orgId, viewer.userId])
    expect(stillOld.rows).toHaveLength(1)
    expect(stillOld.rows[0].disclosure_version).toBe('old-draft')
    expect(stillOld.rows[0].withdrawn_at).toBeNull()

    const again = await native(request(server).post('/api/ai/native-access')).set(auth(viewer.token)).send(seenDisclosure)
    expect(again.status).toBe(201)
    expect(again.body.consent_active).toBe(true)
    const open = await openRows(a.orgId, viewer.userId)
    expect(open).toHaveLength(1)
    expect(open[0].disclosure_version).toBe('draft-2026-10-24')

    const gone = await native(request(server).patch('/api/ai/native-access/withdraw')).set(auth(viewer.token)).send({})
    expect(gone.status).toBe(200)
    expect(gone.body.consent_active).toBe(false)
    expect(gone.body.consent.withdrawn_at).toBeTruthy()
    expect(await openRows(a.orgId, viewer.userId)).toHaveLength(0)
  })

  it('writes nothing when the native build excludes AI', async () => {
    setMode('excluded')
    const before = await openRows(b.orgId, b.userId)
    const res = await native(request(server).post('/api/ai/native-access')).set(auth(b.token)).send({})
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ai_excluded')
    expect(await openRows(b.orgId, b.userId)).toEqual(before)
    const read = await native(request(server).get('/api/ai/native-access')).set(auth(b.token))
    expect(read.body).toMatchObject({ applies: true, mode: 'excluded', consent_active: false })
  })
})

describe('server-ai-generate, server-ai-enhance, server-ai-generations-read, server-ai-provider, server-assistant-post, and server-assistant-status', () => {
  it('refuses every native AI route when excluded, and leaves the web route on its own validation', async () => {
    setMode(null)
    const cases = [
      () => native(request(server).post('/api/ai/generate')).set(auth(a.token)).send({}),
      () => native(request(server).post('/api/ai/enhance')).set(auth(a.token)).send({}),
      () => native(request(server).get('/api/ai/generations')).set(auth(a.token)),
      () => native(request(server).put('/api/ai/provider')).set(auth(a.token)).send({}),
      () => native(request(server).post('/api/assistant')).set(auth(a.token)).send({}),
      () => native(request(server).get('/api/assistant/status')).set(auth(viewer.token)),
    ]
    for (const run of cases) {
      const res = await run()
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('ai_excluded')
    }
    const web = await request(server).post('/api/ai/generate').set(auth(a.token)).send({})
    expect(web.status).toBe(400)
    expect(web.body.code).not.toBe('ai_excluded')
    expect(web.body.code).not.toBe('ai_consent_required')
    const webStatus = await request(server).get('/api/assistant/status').set(auth(a.token))
    expect(webStatus.status).not.toBe(403)
    expect(webStatus.body.code).not.toBe('ai_excluded')
  })

  it('refuses a native send until that person has agreed, then reaches ordinary validation', async () => {
    setMode('consent-required')
    const blocked = await native(request(server).post('/api/assistant')).set(auth(viewer.token)).send({ question: 'Where is the register?' })
    expect(blocked.status).toBe(403)
    expect(blocked.body.code).toBe('ai_consent_required')

    const agreed = await native(request(server).post('/api/ai/native-access')).set(auth(viewer.token)).send(seenDisclosure)
    expect([200, 201]).toContain(agreed.status)
    const passed = await native(request(server).post('/api/assistant')).set(auth(viewer.token)).send({})
    expect(passed.status).toBe(400)
    expect(passed.body.code).not.toBe('ai_consent_required')
    expect(passed.body.code).not.toBe('ai_excluded')
  })
})

async function until(pred, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 40))
  }
  return pred()
}

describe('server-support-triage', () => {
  const body = { description: 'The printed list skipped a name on Sunday morning.' }

  it('still saves a native report and does not start triage when AI is excluded or not agreed', async () => {
    setMode(null)
    dispatch.mockClear()
    const excluded = await native(request(server).post('/api/support-tickets')).set(auth(viewer.token)).send(body)
    expect(excluded.status).toBe(201)
    expect(await until(() => dispatch.mock.calls.length > 0, 1500)).toBe(false)
    expect(dispatch.mock.calls.length).toBe(0)

    setMode('consent-required')
    await pool.query(
      `UPDATE ochr_native_ai_consents SET withdrawn_at = NOW()
        WHERE organization_id = $1 AND user_id = $2 AND withdrawn_at IS NULL`,
      [a.orgId, staff.userId])
    dispatch.mockClear()
    const pending = await native(request(server).post('/api/support-tickets')).set(auth(staff.token)).send(body)
    expect(pending.status).toBe(201)
    expect(await until(() => dispatch.mock.calls.length > 0, 1500)).toBe(false)
    expect(dispatch.mock.calls.length).toBe(0)
  })

  it('starts triage for a web report and for a native report after agreement', async () => {
    setMode('consent-required')
    dispatch.mockClear()
    const web = await request(server).post('/api/support-tickets').set(auth(a.token)).send(body)
    expect(web.status).toBe(201)
    expect(await until(() => dispatch.mock.calls.length > 0, 3000)).toBe(true)

    dispatch.mockClear()
    const nativeAgreed = await native(request(server).post('/api/support-tickets')).set(auth(a.token)).send(body)
    expect(nativeAgreed.status).toBe(201)
    expect(await until(() => dispatch.mock.calls.some(c => c[0]?.nativeShell === true), 3000)).toBe(true)
  })
})

describe('R388-1 build ceiling', () => {
  it('keeps an excluded candidate excluded when the host offers consent and an active agreement', async () => {
    setMode('consent-required')
    const read = await native(request(server).get('/api/ai/native-access'), 'excluded').set(auth(a.token))
    expect(read.body).toMatchObject({ applies: true, mode: 'excluded', consent_active: false })
    const omitted = await request(server).get('/api/ai/native-access').set('User-Agent', NATIVE).set(auth(a.token))
    expect(omitted.body.mode).toBe('excluded')
    const write = await native(request(server).post('/api/ai/native-access'), 'excluded').set(auth(a.token)).send(seenDisclosure)
    expect(write.status).toBe(403)
    expect(write.body.code).toBe('ai_excluded')
    const send = await native(request(server).post('/api/assistant'), 'excluded').set(auth(a.token)).send({ question: 'hello there' })
    expect(send.status).toBe(403)
    expect(send.body.code).toBe('ai_excluded')
  })

  it('refuses a hosted consent-required bundle when the archive user agent has no ceiling token', async () => {
    setMode('consent-required')
    const consentUa = 'OpenChurchNative/1.0 OpenChurchNativeAi/consent-required'
    const agreed = await request(server).post('/api/ai/native-access')
      .set('User-Agent', consentUa)
      .set('X-OC-Native-Ai-Ceiling', 'consent-required')
      .set(auth(a.token))
      .send(seenDisclosure)
    expect([200, 201]).toContain(agreed.status)

    const read = await request(server).get('/api/ai/native-access')
      .set('User-Agent', NATIVE)
      .set('X-OC-Native-Ai-Ceiling', 'consent-required')
      .set(auth(a.token))
    expect(read.body.mode).toBe('excluded')
    expect(read.body.consent_active).toBe(false)

    const send = await request(server).post('/api/assistant')
      .set('User-Agent', NATIVE)
      .set('X-OC-Native-Ai-Ceiling', 'consent-required')
      .set(auth(a.token))
      .send({ question: 'hello there' })
    expect(send.status).toBe(403)
    expect(send.body.code).toBe('ai_excluded')
  })

  it('still excludes a consent-capable candidate when the host excludes AI', async () => {
    setMode('excluded')
    const read = await native(request(server).get('/api/ai/native-access'), 'consent-required').set(auth(b.token))
    expect(read.body.mode).toBe('excluded')
    const write = await native(request(server).post('/api/ai/native-access'), 'consent-required').set(auth(b.token)).send(seenDisclosure)
    expect(write.status).toBe(403)
    expect(write.body.code).toBe('ai_excluded')
  })
})

describe('R388-2 displayed disclosure version', () => {
  it('refuses a missing version, records the matching one, and allows withdrawal then agreement again', async () => {
    setMode('consent-required')
    await pool.query(
      `UPDATE ochr_native_ai_consents SET withdrawn_at = NOW()
        WHERE organization_id = $1 AND user_id = $2 AND withdrawn_at IS NULL`,
      [b.orgId, b.userId])
    const missing = await native(request(server).post('/api/ai/native-access')).set(auth(b.token)).send({})
    expect(missing.status).toBe(409)
    expect(missing.body.code).toBe('ai_disclosure_mismatch')
    expect(await openRows(b.orgId, b.userId)).toHaveLength(0)

    const recorded = await native(request(server).post('/api/ai/native-access')).set(auth(b.token)).send(seenDisclosure)
    expect(recorded.status).toBe(201)
    expect(recorded.body.consent.disclosure_version).toBe(NATIVE_AI_DISCLOSURE_VERSION)
    expect(recorded.body.required_disclosure_version).toBe(NATIVE_AI_DISCLOSURE_VERSION)

    const withdrawn = await native(request(server).patch('/api/ai/native-access/withdraw')).set(auth(b.token)).send({})
    expect(withdrawn.status).toBe(200)
    expect(withdrawn.body.consent_active).toBe(false)
    const again = await native(request(server).post('/api/ai/native-access')).set(auth(b.token)).send(seenDisclosure)
    expect(again.status).toBe(201)
    expect(again.body.consent_active).toBe(true)
    expect(await openRows(b.orgId, b.userId)).toHaveLength(1)
  })
})

describe('128-native-ai-consent', () => {
  it('follows 127 (129 is now the head) and re-runs as a no-op', async () => {
    const { MIGRATION_NAMES, EXPECTED_MIGRATION } = await import('../src/migrations/names.js')
    expect(EXPECTED_MIGRATION).toBe('144-online-giving-clearing')
    const i = MIGRATION_NAMES.indexOf('128-native-ai-consent')
    expect(MIGRATION_NAMES[i - 1]).toBe('127-account-deletion-requests')
    const { up } = await import('../src/migrations/128-native-ai-consent.js')
    await up()
    await up()
    const rls = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'ochr_native_ai_consents'`)
    expect(rls.rows[0].relrowsecurity).toBe(true)
  })
})
