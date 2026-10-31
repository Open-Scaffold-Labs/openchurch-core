// Level A — reversible login deactivation.
//
// The row stays. Sessions die because token_version moves. A later
// reactivation moves it again, so the sessions from before do not come
// back. Nothing here deletes a member, a gift, a register row, or the
// organization.

import { sqlNormEmail } from '../utils/emailNorm.js'
import pool from '../db.js'
import { RECORD_ADDRESSED_TYPES } from '../notifications/transport.js'

export const ONLY_ACTIVE_ADMIN =
  'Cannot deactivate the only active admin. Transfer administration first. Closing the organization is a separate step and is not done here.'

export const DEACTIVATED_LOGIN =
  'This login is deactivated. An admin can turn it back on.'

export const RESET_DOES_NOT_REACTIVATE =
  'This login is deactivated. A password reset does not turn it back on.'

export const INVITE_DOES_NOT_REACTIVATE =
  'This login is deactivated. An invitation does not turn it back on.'

export const PASSWORD_DOES_NOT_REACTIVATE =
  'This login is deactivated. Changing the password does not turn it back on.'

export function withLoginTransaction(fn, options) {
  return withTransaction(fn, options)
}

// The organization admission boundary for any multi-row change in a tenant
// (profile minimization, role changes, login lifecycle): organization KEY
// SHARE first, refuse a held organization with 409, then the callback takes
// its row locks. Same contract as withLoginTransaction with an organization.
export function withOrganizationAdmission(organizationId, fn) {
  if (organizationId == null) throw new Error('withOrganizationAdmission needs an organization id')
  return withTransaction(fn, { organizationId })
}

async function withTransaction(fn, { organizationId } = {}) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (organizationId != null) {
      // Admission boundary: organization first, before any user/profile row
      // lock. HOLD takes FOR UPDATE on the same row, so it waits for this
      // transaction and this transaction refuses a held organization.
      const { rows: [org] } = await client.query('SELECT held_at FROM ochr_organizations WHERE id = $1 FOR KEY SHARE', [organizationId])
      if (!org) {
        await client.query('ROLLBACK')
        return { status: 404, body: { error: 'Organization not found' } }
      }
      if (org.held_at != null) {
        await client.query('ROLLBACK')
        return { status: 409, body: { error: 'Organization is on hold. No changes were made.' } }
      }
    }
    const result = await fn(client)
    if (result.status >= 400) await client.query('ROLLBACK')
    else await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// One lock, one order, for every operation that can reduce the number of
// active admins: deactivation, demotion, and delete. The set is the target
// row plus every still-active admin, always locked in id order. A count
// taken outside this lock can see a second active admin that a concurrent
// deactivation, demotion, or delete is about to remove.
export async function lockLoginForAdminCount(client, organizationId, targetId) {
  const { rows } = await client.query(
    `SELECT id, role, email, deactivated_at, closed_at, invited_at, invite_accepted_at
       FROM ochr_users
      WHERE organization_id = $1
        AND (id = $2 OR (role = 'admin' AND deactivated_at IS NULL AND closed_at IS NULL))
      ORDER BY id
        FOR UPDATE`,
    [organizationId, targetId]
  )
  const target = rows.find(row => Number(row.id) === Number(targetId)) ?? null
  return { target, rows }
}

// F-06: cancel this org's queued (pending OR already-claimed 'processing')
// scheduled notifications addressed to a login, matched by user id or by its
// (pre-closure) address. Reactivation does not restore them. A claimed row
// cancelled here is refused at the dispatch boundary (transport.js checks
// the row is still 'processing' immediately before any transport), so a
// closure committing after a claim stops the send (R286-3).
//
// C3 (CAROLINA-423 M2): with skipRecordAddressedTypes, the ADDRESS match
// leaves record-addressed types (a donation receipt to a member or donor
// record that shares the address) alone. Rows addressed by this login's
// id are still cancelled whatever their type.
export async function cancelPendingNotificationsForLogin(client, organizationId, userId, email, reason = 'login closed or deactivated', { skipRecordAddressedTypes = null } = {}) {
  const skip = skipRecordAddressedTypes ? [...skipRecordAddressedTypes] : null
  await client.query(
    `UPDATE ochr_scheduled_notifications
        SET status = 'cancelled',
            error  = COALESCE(error, 'cancelled: ' || $4::text)
      WHERE organization_id = $1
        AND status IN ('pending', 'processing')
        AND (user_id = $2 OR ($3::text IS NOT NULL AND ${sqlNormEmail('recipient_email')} = ${sqlNormEmail('$3::text')}
                              AND ($5::text[] IS NULL OR NOT (notification_type = ANY($5::text[])))))`,
    [organizationId, userId, email ?? null, reason, skip]
  )
}

// C3 (CAROLINA-423 H1): an admin invite nobody accepted is not a usable
// admin. Same predicate as setup.js: added some other way (invited_at
// NULL) or invited and accepted. The pending row is still locked by
// lockLoginForAdminCount, so an acceptance racing this count waits.
export function isUsableAdminRow(row) {
  return row.role === 'admin' &&
    row.deactivated_at == null &&
    row.closed_at == null &&
    (row.invited_at == null || row.invite_accepted_at != null)
}

export function countOtherUsableAdmins(rows, targetId) {
  return rows.filter(row => isUsableAdminRow(row) && Number(row.id) !== Number(targetId)).length
}

// Every last-admin guard (deactivation, closure, demotion, deletion)
// uses countOtherUsableAdmins. The old countOtherActiveAdmins counted an
// admin invite nobody accepted, so a sole real admin could deactivate,
// close or demote themselves and leave no admin who can sign in
// (CAROLINA-423-R2). It is removed so no caller can fall back to it.

// Locks the target and every still-active admin in the org, in id order,
// so two concurrent reductions cannot both pass the last-admin check.
export function deactivateLogin({ organizationId, targetId }) {
  return withTransaction(async (client) => {
    const { target, rows } = await lockLoginForAdminCount(client, organizationId, targetId)
    if (!target) return { status: 404, body: { error: 'User not found' } }
    if (target.deactivated_at) {
      return { status: 200, body: { deactivated: true, already: true } }
    }
    if (target.role === 'admin' && countOtherUsableAdmins(rows, targetId) === 0) {
      return { status: 409, body: { error: ONLY_ACTIVE_ADMIN } }
    }
    const { rows: updated } = await client.query(
      `UPDATE ochr_users
          SET deactivated_at = NOW(),
              token_version = COALESCE(token_version, 1) + 1
        WHERE id = $1
          AND organization_id = $2
          AND deactivated_at IS NULL
        RETURNING id`,
      [targetId, organizationId]
    )
    if (!updated.length) {
      return { status: 200, body: { deactivated: true, already: true } }
    }
    // F-06 / ARG-PATCH-2-1: a deactivated login stops receiving queued mail.
    // Ledger #430 P3-1 / CAROLINA-430 #9: deactivation is not member removal
    // either, so the ADDRESS match skips record-addressed types (a queued
    // donation receipt, gift notice or serving reminder to a member or donor
    // record that shares the address), the same filter closure and deletion
    // use. Rows addressed to this login's id are still cancelled whatever
    // their type, and login-addressed types matched by address still are.
    await cancelPendingNotificationsForLogin(client, organizationId, targetId, target.email, undefined,
      { skipRecordAddressedTypes: RECORD_ADDRESSED_TYPES })
    return { status: 200, body: { deactivated: true, already: false } }
  }, { organizationId })
}

// Clears the flag and moves token_version again. Does not sign a token.
// An already-active login is left alone so a repeated call does not
// sign that person out.
export function reactivateLogin({ organizationId, targetId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, deactivated_at, closed_at
         FROM ochr_users
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [targetId, organizationId]
    )
    if (!rows.length) return { status: 404, body: { error: 'User not found' } }
    if (rows[0].closed_at != null) {
      return {
        status: 409,
        body: { error: 'This login is closed. Turning it back on is not available.' },
      }
    }
    if (rows[0].deactivated_at == null) {
      return { status: 200, body: { reactivated: false, already: true } }
    }
    await client.query(
      `UPDATE ochr_users
          SET deactivated_at = NULL,
              token_version = COALESCE(token_version, 1) + 1
        WHERE id = $1 AND organization_id = $2`,
      [targetId, organizationId]
    )
    return { status: 200, body: { reactivated: true, already: false } }
  }, { organizationId })
}
