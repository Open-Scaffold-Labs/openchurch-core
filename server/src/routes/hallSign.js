// Public signing link for a parish hall agreement.
//
// The token is the credential. The parish id in the token prefix must
// match the agreement row. The body cannot name a parish. Mail is not
// sent from here: a signature on this link is not email-verified.
// Nothing on this router charges money or writes the sacramental register.
//
// Each method is mounted on its own path in app.js, with its own limiter,
// so the public allowlist names METHOD + path and not the whole prefix.

import rateLimit from 'express-rate-limit'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { hashSigningToken, parishTokenPrefix, sha256, SIGN_LINK_TTL_MS, signLinkExpired } from '../lib/esign/hallTokens.js'
import { consentPoints, consentAccepted, CONSENT_VERSION, agreementCounselPending } from '../lib/esign/hallConsent.js'

const THIRTY_DAYS_MS = SIGN_LINK_TTL_MS

export const hallSignReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'rate_limited', payments: 'on_hold' },
})

export const hallSignWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'rate_limited', payments: 'on_hold' },
})

function notFound(res) {
  res.status(404).json({ code: 'not_found', payments: 'on_hold' })
}

function expired(res) {
  res.status(410).json({ code: 'expired', payments: 'on_hold' })
}

async function loadByToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
  const hash = hashSigningToken(token)
  const { rows } = await pool.query(
    `SELECT a.id, a.organization_id, a.booking_id, a.status, a.contract_en, a.contract_es,
            a.contract_sha256, a.sent_at, a.signed_at, a.signer_name, a.email_verified,
            b.host_name, b.event_kind, b.status AS booking_status, s.name AS space_name
       FROM ochr_cat_agreements a
       JOIN ochr_cat_bookings b
         ON b.id = a.booking_id AND b.organization_id = a.organization_id
       JOIN ochr_cat_spaces s
         ON s.id = b.space_id AND s.organization_id = b.organization_id
      WHERE a.token_hash = $1`,
    [hash])
  const row = rows[0]
  if (!row) return null
  if (!token.startsWith(`${parishTokenPrefix(row.organization_id)}.`)) return null
  return row
}

function ageMs(value) {
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY
}

function linkExpired(row) {
  return signLinkExpired(row)
}

function localeOf(req) {
  const q = req.query?.locale
  if (q === 'es' || q === 'en') return q
  return 'en'
}

function view(row, locale) {
  return {
    payments: 'on_hold',
    status: row.status,
    email_verified: false,
    host_name: row.host_name,
    space_name: row.space_name,
    event_kind: row.event_kind,
    contract: locale === 'es' ? row.contract_es : row.contract_en,
    consent: consentPoints(locale),
    consent_version: CONSENT_VERSION,
    signer_name: row.signer_name,
    // Counsel's wording is not in this agreement yet. It can be read, and
    // declined, but not signed.
    counsel_pending: agreementCounselPending(row.contract_en, row.contract_es),
  }
}

function visitor(req) {
  const ip = typeof req.ip === 'string' ? req.ip : ''
  const agent = req.get?.('user-agent')
  return {
    ip_hash: ip ? sha256(`hall-sign-ip:${ip}`) : null,
    user_agent: typeof agent === 'string' && agent.trim() ? agent.trim().slice(0, 200) : 'unspecified',
  }
}

async function appendEvent(db, row, kind, payload) {
  await db.query(
    `INSERT INTO ochr_cat_agreement_events (organization_id, agreement_id, kind, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [row.organization_id, row.id, kind, JSON.stringify(payload)])
}

async function openedRecently(row) {
  const { rows } = await pool.query(
    `SELECT 1 FROM ochr_cat_agreement_events
      WHERE agreement_id = $1 AND organization_id = $2 AND kind = 'link.opened'
        AND created_at > NOW() - INTERVAL '15 minutes'
      LIMIT 1`,
    [row.id, row.organization_id])
  return rows.length > 0
}

export async function hallSignGet(req, res) {
  try {
    const row = await loadByToken(req.params.token)
    if (!row || row.status === 'draft' || row.status === 'voided' || row.status === 'declined') return notFound(res)
    if (linkExpired(row)) return expired(res)
    const locale = localeOf(req)
    if (!(await openedRecently(row))) {
      await appendEvent(pool, row, 'link.opened', {
        token_fingerprint: hashSigningToken(req.params.token).slice(0, 12),
        locale,
      })
    }
    res.json(view(row, locale))
  } catch (err) {
    monitor.error('hallSign.read', err, {})
    res.status(500).json({ code: 'load_failed', payments: 'on_hold' })
  }
}

export async function hallSignSign(req, res) {
  const locale = req.body?.locale === 'es' ? 'es' : 'en'
  const name = typeof req.body?.signer_name === 'string' ? req.body.signer_name.trim() : ''
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const row = await loadByToken(req.params.token)
    if (!row || row.status === 'draft' || row.status === 'voided') {
      await client.query('ROLLBACK')
      return notFound(res)
    }
    const { rows } = await client.query(
      `SELECT a.id, a.organization_id, a.status, a.contract_sha256, a.sent_at, a.contract_en, a.contract_es,
              b.status AS booking_status
         FROM ochr_cat_agreements a
         JOIN ochr_cat_bookings b
           ON b.id = a.booking_id AND b.organization_id = a.organization_id
        WHERE a.id = $1 AND a.organization_id = $2
        FOR UPDATE OF a`,
      [row.id, row.organization_id])
    const current = rows[0]
    if (!current || (current.status !== 'sent' && current.status !== 'signed')) {
      await client.query('ROLLBACK')
      return res.status(409).json({ code: 'not_open', payments: 'on_hold' })
    }
    if (current.status === 'sent' && ageMs(current.sent_at) > THIRTY_DAYS_MS) {
      await client.query('ROLLBACK')
      return expired(res)
    }
    if (current.status !== 'sent') {
      await client.query('ROLLBACK')
      return res.status(409).json({ code: 'already_signed', payments: 'on_hold' })
    }
    if (current.booking_status !== 'held') {
      await client.query('ROLLBACK')
      return res.status(409).json({ code: 'not_held', payments: 'on_hold' })
    }
    // Checked on the locked row: a placeholder in the text or the consent
    // list means counsel has not supplied the terms, so nothing is signed.
    if (agreementCounselPending(current.contract_en, current.contract_es)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ code: 'counsel_pending', payments: 'on_hold' })
    }
    if (name.length < 2 || name.length > 120) {
      await client.query('ROLLBACK')
      return res.status(400).json({ code: 'name', payments: 'on_hold' })
    }
    if (!consentAccepted(locale, req.body?.accepted)) {
      await client.query('ROLLBACK')
      return res.status(400).json({ code: 'consent', payments: 'on_hold' })
    }
    const signedAt = new Date().toISOString()
    const seal = sha256(JSON.stringify({
      contract_sha256: current.contract_sha256,
      signer_name: name,
      signed_at: signedAt,
      consent_version: CONSENT_VERSION,
      payments: 'on_hold',
    }))
    const who = visitor(req)
    await appendEvent(client, row, 'signer.consented', {
      consent_version: CONSENT_VERSION,
      locale,
      points: consentPoints(locale).map(p => p.id),
      ...who,
    })
    await appendEvent(client, row, 'signer.signed', {
      signer_name: name,
      signed_at: signedAt,
      auth_method: 'copy_link',
      email_verified: false,
      ...who,
    })
    await appendEvent(client, row, 'request.sealed', { seal_sha256: seal })
    await client.query(
      `UPDATE ochr_cat_agreements
          SET status = 'signed', signed_at = $3, signer_name = $4, seal_sha256 = $5, email_verified = FALSE
        WHERE id = $1 AND organization_id = $2 AND status = 'sent'`,
      [row.id, row.organization_id, signedAt, name, seal])
    await client.query('COMMIT')
    res.json({ payments: 'on_hold', status: 'signed', email_verified: false, seal_sha256: seal })
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* report the original failure */ }
    monitor.error('hallSign.sign', err, {})
    if (!res.headersSent) res.status(500).json({ code: 'save_failed', payments: 'on_hold' })
  } finally {
    client.release()
  }
}

export async function hallSignDecline(req, res) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const row = await loadByToken(req.params.token)
    if (!row || row.status !== 'sent') {
      await client.query('ROLLBACK')
      return notFound(res)
    }
    const { rows } = await client.query(
      `SELECT status, sent_at FROM ochr_cat_agreements
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [row.id, row.organization_id])
    if (rows[0]?.status !== 'sent') {
      await client.query('ROLLBACK')
      return notFound(res)
    }
    if (ageMs(rows[0].sent_at) > THIRTY_DAYS_MS) {
      await client.query('ROLLBACK')
      return expired(res)
    }
    if (reason.length < 3 || reason.length > 500) {
      await client.query('ROLLBACK')
      return res.status(400).json({ code: 'reason', payments: 'on_hold' })
    }
    await appendEvent(client, row, 'signer.declined', { reason, ...visitor(req) })
    await client.query(
      `UPDATE ochr_cat_agreements
          SET status = 'declined', token_hash = NULL, token_sealed = NULL
        WHERE id = $1 AND organization_id = $2 AND status = 'sent'`,
      [row.id, row.organization_id])
    await client.query('COMMIT')
    res.json({ payments: 'on_hold', status: 'declined' })
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* report the original failure */ }
    monitor.error('hallSign.decline', err, {})
    if (!res.headersSent) res.status(500).json({ code: 'save_failed', payments: 'on_hold' })
  } finally {
    client.release()
  }
}
