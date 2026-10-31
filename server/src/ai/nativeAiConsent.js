// Per-person agreement for AI inside the native shell. One open row per
// login per parish. Withdrawal sets withdrawn_at; the row stays so the
// fact of an earlier agreement is not erased. A newer disclosure version
// retires the open row in the same transaction before the new one is written.
//
// The login and the parish come from the verified JWT. Callers must not
// pass identifiers from the request body.

import pool from '../db.js'
import { NATIVE_AI_DISCLOSURE_VERSION } from './nativeAiMode.js'

const COLUMNS = 'id, disclosure_version, consented_at, withdrawn_at'

export function shapeNativeAiConsent(row) {
  if (!row) return null
  return {
    disclosure_version: row.disclosure_version,
    consented_at: row.consented_at,
    withdrawn_at: row.withdrawn_at,
  }
}

function isActive(row) {
  return !!row && row.withdrawn_at == null && row.disclosure_version === NATIVE_AI_DISCLOSURE_VERSION
}

export async function latestNativeAiConsent(db, organizationId, userId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM ochr_native_ai_consents
      WHERE organization_id = $1 AND user_id = $2
      ORDER BY consented_at DESC, id DESC
      LIMIT 1`,
    [organizationId, userId])
  return rows[0] || null
}

export async function hasActiveNativeAiConsent(organizationId, userId) {
  const row = await latestNativeAiConsent(pool, organizationId, userId)
  return isActive(row)
}

export async function nativeAiConsentView(organizationId, userId) {
  const row = await latestNativeAiConsent(pool, organizationId, userId)
  return { consent: shapeNativeAiConsent(row), consent_active: isActive(row) }
}

export async function recordNativeAiConsent({ organizationId, userId, disclosureVersion }) {
  // Refuse before any write. A missing, stale, or newer version must not
  // retire the open row or stamp the server's version onto unseen copy.
  if (disclosureVersion !== NATIVE_AI_DISCLOSURE_VERSION) {
    const mismatch = new Error('ai_disclosure_mismatch')
    mismatch.code = 'ai_disclosure_mismatch'
    mismatch.requiredDisclosureVersion = NATIVE_AI_DISCLOSURE_VERSION
    throw mismatch
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: open } = await client.query(
      `SELECT ${COLUMNS} FROM ochr_native_ai_consents
        WHERE organization_id = $1 AND user_id = $2 AND withdrawn_at IS NULL
        FOR UPDATE`,
      [organizationId, userId])
    const current = open[0]
    if (isActive(current)) {
      await client.query('COMMIT')
      return { consent: shapeNativeAiConsent(current), consent_active: true, already: true }
    }
    if (current) {
      await client.query(
        `UPDATE ochr_native_ai_consents
            SET withdrawn_at = NOW()
          WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND withdrawn_at IS NULL`,
        [current.id, organizationId, userId])
    }
    const { rows } = await client.query(
      `INSERT INTO ochr_native_ai_consents (organization_id, user_id, disclosure_version)
       VALUES ($1, $2, $3)
       RETURNING ${COLUMNS}`,
      [organizationId, userId, disclosureVersion])
    await client.query('COMMIT')
    return { consent: shapeNativeAiConsent(rows[0]), consent_active: true, already: false }
  } catch (err) {
    await client.query('ROLLBACK')
    if (err?.code === '23505') {
      const view = await nativeAiConsentView(organizationId, userId)
      if (view.consent_active) return { ...view, already: true }
    }
    throw err
  } finally {
    client.release()
  }
}

export async function withdrawNativeAiConsent({ organizationId, userId }) {
  await pool.query(
    `UPDATE ochr_native_ai_consents
        SET withdrawn_at = NOW()
      WHERE organization_id = $1 AND user_id = $2 AND withdrawn_at IS NULL`,
    [organizationId, userId])
  const view = await nativeAiConsentView(organizationId, userId)
  return view
}
