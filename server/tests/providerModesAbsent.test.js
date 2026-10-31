// Absent email, AI, Stripe, and Blob. Each mode stays honest: a named
// disabled state, and no provider HTTP call.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, migrateOnce } from './support/harness.js'
import { sendEmail } from '../src/email/send.js'
import { resolveRoute } from '../src/ai/gate.js'
import { createCheckoutSession, verifyWebhook } from '../src/billing/provider.js'
import {
  paymentsConfigured,
  paymentsProvider,
  paymentsCanMoveMoney,
} from '../src/payments/index.js'
import { describeStorage } from '../src/storage/index.js'
import { runWeeklyBackupDigest } from '../src/services/backupDigest.js'
import { openStore } from '../../scripts/backup-export/blob-store.mjs'

const TOUCHED = [
  'NODE_ENV',
  'RESEND_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'BILLING_PROVIDER_SECRET',
  'BILLING_WEBHOOK_SECRET',
  'PAYMENTS_PROVIDER',
  'PAYMENTS_PROVIDER_SECRET',
  'BACKUP_STORAGE',
  'BACKUP_DIR',
  'BACKUP_S3_BUCKET',
  'BACKUP_S3_KEY_ID',
  'BACKUP_S3_SECRET',
  'BACKUP_S3_ENDPOINT',
  'BACKUP_S3_REGION',
  'BACKUP_S3_FORCE_PATH_STYLE',
  'BLOB_READ_WRITE_TOKEN',
  'OC_BACKUP_BLOB_STUB_DIR',
  'SUPER_ADMIN_EMAIL',
  'VERCEL',
]

const saved = {}

function clearProviders() {
  for (const key of TOUCHED) {
    if (!(key in saved)) saved[key] = process.env[key]
    if (key !== 'NODE_ENV') delete process.env[key]
  }
}

function restore() {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

beforeAll(async () => {
  await migrateOnce()
}, 60_000)

afterEach(() => {
  vi.restoreAllMocks()
  restore()
})

afterAll(async () => {
  await pool.end()
})

describe('provider modes when credentials are absent', () => {
  it('email: development stubs without fetch; production refuses', async () => {
    clearProviders()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    process.env.NODE_ENV = 'test'
    const stub = await sendEmail({ to: 'synthetic@example.com', subject: 'Synthetic', text: 'Synthetic body' })
    expect(stub.ok).toBe(true)
    expect(String(stub.id)).toMatch(/^stub-/)
    expect(fetchSpy).not.toHaveBeenCalled()

    process.env.NODE_ENV = 'production'
    await expect(sendEmail({ to: 'synthetic@example.com', subject: 'Synthetic', text: 'Synthetic body' }))
      .rejects.toMatchObject({ code: 'EMAIL_TRANSPORT_UNCONFIGURED' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('AI: parish work asks for a parish key; managed triage is unavailable', async () => {
    clearProviders()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const orgId = 0
    await expect(resolveRoute(orgId, 'parish_text_enhance_v1')).rejects.toMatchObject({ code: 'ai_key_required' })
    await expect(resolveRoute(orgId, 'support_triage_v1')).rejects.toMatchObject({ code: 'ai_unavailable' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('Stripe: billing checkout is a stub URL and giving is not configured', async () => {
    clearProviders()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(paymentsConfigured()).toBe(false)
    expect(paymentsProvider()).toBe('stub')
    expect(paymentsCanMoveMoney()).toBe(false)

    const slug = `provider-absent-${RUN_ID}`.replace(/_/g, '-').slice(0, 60)
    const { rows } = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, org_type, tradition)
       VALUES ($1, $2, 'parish', 'catholic') RETURNING id`,
      [`Synthetic Provider Parish ${RUN_ID}`, slug],
    )
    const orgId = rows[0].id
    try {
      const session = await createCheckoutSession({
        orgId,
        planId: 'pro',
        successUrl: 'https://example.com/billing/done',
        cancelUrl: 'https://example.com/billing/cancel',
      })
      expect(session.url).toContain('stub_checkout=1')
      const verified = await verifyWebhook({ rawBody: Buffer.from('{}'), signature: '' })
      expect(verified.result).toEqual({ received: true, stub: true })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId])
    }
  })

  it('Blob and backup storage: no token and no store, and the digest builds nothing', async () => {
    clearProviders()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(openStore({})).rejects.toThrow(/BLOB_READ_WRITE_TOKEN is not set/)
    expect(describeStorage()).toMatchObject({ driver: 'none', live: false })
    const digest = await runWeeklyBackupDigest({ now: new Date('2026-10-18T12:00:00Z') })
    expect(digest.skipped).toMatch(/no backup storage configured/)
    expect(digest.notified).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
