// Account deletion REQUEST plumbing (P1 lane B, TARS #62 6380348243).
//
// What this does: records that the signed-in person asked for their account
// to be deleted, asks them to confirm with their password, lets them see the
// status, and lets them withdraw an open request.
//
// Confirming the request deletes that login's personal data immediately
// (C3, Dale #342 comment 6429592110). Parish sacramental registers and
// the contribution and financial ledger are kept. A full purge is not
// what this does. The only active admin is refused.

import bcrypt from 'bcryptjs'
import pool from '../db.js'
import { ORGANIZATION_HELD, isHoldRefusal } from './organizationHold.js'
import { withLoginTransaction, lockLoginForAdminCount, countOtherUsableAdmins } from './loginDeactivation.js'
import { fulfilLoginDeletion, ONLY_ACTIVE_ADMIN_DELETE } from './loginDeletion.js'

// Fixed facts carried on every response. Tests pin these.
// data_deleted / personal_login_deleted are per request, not constants:
// they are true only once this login's personal data has been deleted.
export const DELETION_REQUEST_FACTS = Object.freeze({
  purge_performed: false,
  fulfilment_implemented: true,
  processing_owner: 'signed_in_user',
  disposition_policy: 'c3_self_serve_login_deletion',
  sacramental_registers_retained: true,
  financial_ledger_retained: true,
  financial_retention_years: 7,
  exception_contact: 'support@openscaffoldlabs.com',
})

const COLUMNS = 'id, status, fulfilment_status, requested_at, confirmed_at, withdrawn_at'

function shape(row, extra = {}) {
  const personal = row?.fulfilment_status === 'completed'
  return {
    request: row ? {
      id: Number(row.id),
      status: row.status,
      fulfilment_status: row.fulfilment_status,
      requested_at: row.requested_at,
      confirmed_at: row.confirmed_at,
      withdrawn_at: row.withdrawn_at,
    } : null,
    ...DELETION_REQUEST_FACTS,
    ...extra,
    data_deleted: personal,
    personal_login_deleted: personal,
  }
}

async function isOnlyActiveAdmin(db, organizationId, userId) {
  const { rows } = await db.query(
    `SELECT role,
            (SELECT COUNT(*)::int FROM ochr_users o
              WHERE o.organization_id = $1 AND o.id <> $2 AND o.role = 'admin'
                AND o.deactivated_at IS NULL AND o.closed_at IS NULL
                AND (o.invited_at IS NULL OR o.invite_accepted_at IS NOT NULL)) AS other_admins
       FROM ochr_users WHERE id = $2 AND organization_id = $1`,
    [organizationId, userId])
  const r = rows[0]
  return !!r && r.role === 'admin' && r.other_admins === 0
}

async function latest(db, organizationId, userId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM ochr_account_deletion_requests
      WHERE organization_id = $1 AND user_id = $2
      ORDER BY requested_at DESC, id DESC LIMIT 1`,
    [organizationId, userId])
  return rows[0] || null
}

// Re-read ONE specific request (scoped to tenant + user). Used after a
// conditional transition loses a race: the answer must be about the request
// the caller acted on, never a newer one (TARS R383-1).
async function byId(db, id, organizationId, userId, forUpdate = false) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM ochr_account_deletion_requests
      WHERE id = $1 AND organization_id = $2 AND user_id = $3
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id, organizationId, userId])
  return rows[0] || null
}

const CONFLICT = 'This deletion request changed while you were acting on it. Reload and try again.'

// Lost-race outcome for the same request id: idempotent 200 when the row
// already reached the target state, otherwise an honest 409 carrying that
// same request (never a substituted one).
function afterLostRace(row, target) {
  if (row && row.status === target) return { status: 200, body: shape(row, { already: true }) }
  return { status: 409, body: { error: CONFLICT, ...shape(row) } }
}

function held(err) {
  return isHoldRefusal(err) ? { status: 409, body: { error: ORGANIZATION_HELD } } : null
}

export async function deletionRequestStatus({ organizationId, userId }) {
  const row = await latest(pool, organizationId, userId)
  return { status: 200, body: shape(row, {
    last_active_admin: await isOnlyActiveAdmin(pool, organizationId, userId),
  }) }
}

export async function createDeletionRequest({ organizationId, userId }) {
  const open = await latest(pool, organizationId, userId)
  const lastAdmin = await isOnlyActiveAdmin(pool, organizationId, userId)
  if (open && open.status !== 'withdrawn') {
    return { status: 200, body: shape(open, { already: true, last_active_admin: lastAdmin }) }
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO ochr_account_deletion_requests (organization_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [organizationId, userId])
    if (!rows[0]) {
      // A concurrent request won the one-open-request index.
      return { status: 200, body: shape(await latest(pool, organizationId, userId), { already: true, last_active_admin: lastAdmin }) }
    }
    return { status: 201, body: shape(rows[0], { last_active_admin: lastAdmin }) }
  } catch (err) {
    const h = held(err); if (h) return h
    throw err
  }
}

export async function confirmDeletionRequest({ organizationId, userId, password }) {
  const open = await latest(pool, organizationId, userId)
  if (!open || open.status === 'withdrawn') {
    return { status: 404, body: { error: 'There is no open deletion request to confirm.', ...shape(open) } }
  }
  if (open.fulfilment_status === 'completed') {
    return { status: 200, body: shape(open, { already: true }) }
  }
  if (typeof password !== 'string' || !password) {
    return { status: 400, body: { error: 'Enter your password to confirm.' } }
  }
  try {
    // Organization KEY SHARE (withLoginTransaction), then THIS request
    // row, then the user rows in id order.
    //
    // The request comes before the user rows on purpose. Its user foreign
    // key takes a share lock on the login. A transaction that already
    // holds the request (a withdraw racing this confirm) and then inserts
    // the next request needs that share lock. Taking the user lock first
    // and the request second deadlocks with it. Every confirm uses this
    // same order.
    return await withLoginTransaction(async (client) => {
      const reqRow = await byId(client, open.id, organizationId, userId, true)
      if (!reqRow) {
        return { status: 404, body: { error: 'There is no open deletion request to confirm.', ...shape(null) } }
      }
      if (reqRow.fulfilment_status === 'completed') {
        return { status: 200, body: shape(reqRow, { already: true }) }
      }
      if (reqRow.status !== 'requested' && reqRow.status !== 'confirmed') {
        return afterLostRace(reqRow, 'confirmed')
      }
      const { target, rows } = await lockLoginForAdminCount(client, organizationId, userId)
      if (!target) return { status: 404, body: { error: 'User not found', ...shape(null) } }
      if (target.role === 'admin' && !target.closed_at && countOtherUsableAdmins(rows, userId) === 0) {
        return {
          status: 409,
          body: { error: ONLY_ACTIVE_ADMIN_DELETE, ...shape(reqRow, { last_active_admin: true }) },
        }
      }
      const { rows: [fresh] } = await client.query(
        'SELECT password_hash FROM ochr_users WHERE id = $1 AND organization_id = $2',
        [userId, organizationId])
      const ok = fresh?.password_hash ? await bcrypt.compare(password, fresh.password_hash) : false
      if (!ok) return { status: 403, body: { error: 'Password is incorrect.' } }

      await fulfilLoginDeletion(client, { organizationId, userId, target })
      const { rows: updated } = await client.query(
        `UPDATE ochr_account_deletion_requests
            SET status = 'confirmed',
                fulfilment_status = 'completed',
                confirmed_at = COALESCE(confirmed_at, NOW())
          WHERE id = $1 AND organization_id = $2 AND user_id = $3
            AND status IN ('requested', 'confirmed')
            AND fulfilment_status <> 'completed'
          RETURNING ${COLUMNS}`,
        [open.id, organizationId, userId])
      if (updated[0]) return { status: 200, body: shape(updated[0]) }
      return afterLostRace(await byId(client, open.id, organizationId, userId), 'confirmed')
    }, { organizationId })
  } catch (err) {
    const h = held(err); if (h) return h
    throw err
  }
}

export async function withdrawDeletionRequest({ organizationId, userId }) {
  const open = await latest(pool, organizationId, userId)
  if (!open || open.status === 'withdrawn') {
    return { status: 404, body: { error: 'There is no open deletion request to withdraw.', ...shape(open) } }
  }
  if (open.fulfilment_status === 'completed') {
    return {
      status: 409,
      body: {
        error: 'This login is already deleted. Withdrawing the request does not restore it.',
        ...shape(open),
      },
    }
  }
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_account_deletion_requests
          SET status = 'withdrawn', withdrawn_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND status IN ('requested', 'confirmed')
        RETURNING ${COLUMNS}`,
      [open.id, organizationId, userId])
    if (rows[0]) return { status: 200, body: shape(rows[0]) }
    return afterLostRace(await byId(pool, open.id, organizationId, userId), 'withdrawn')
  } catch (err) {
    const h = held(err); if (h) return h
    throw err
  }
}
