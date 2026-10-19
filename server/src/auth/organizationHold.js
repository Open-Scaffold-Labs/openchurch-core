import { monitor } from '../monitoring/index.js'
import pool from '../db.js'

const HOLD_LOCK_TIMEOUT = '15s'

export const ORGANIZATION_HELD =
  'This organization is on hold. Access is stopped; parish history remains.'

// The database refuses a write for a held organization (migration 114 guard)
// or a capability for a closed login (migration 113) with SQLSTATE 23514.
// Routes that raced a HOLD or a closure map these to an honest refusal
// instead of a 500.
export function isHoldRefusal(err) {
  return err?.code === '23514' && /on hold/i.test(err?.message ?? '')
}
export function isClosedCapabilityRefusal(err) {
  return err?.code === '23514' && /Closed login cannot receive/i.test(err?.message ?? '')
}

// A hold revokes live access; it never deletes parish history or promises
// deletion at providers. No retention clock or automatic unhold is implied.
//
// Two transactions, on purpose.
//
// 1. Hold. Lock ONLY the organization row (FOR UPDATE), check the actor and
//    the confirmation, set held_at, commit. Every write for this tenant takes
//    a KEY SHARE admission lock on the same row (migration 114 guard, the
//    capability triggers in 113, withOrganizationAdmission below), so this
//    waits for in-flight writes and every later write sees held_at and is
//    refused. Because this phase holds no other row lock, a writer that owns
//    a user/profile row and then asks for the organization cannot deadlock
//    with it.
// 2. Revoke. Turn logins off, bump token versions, drop reset/invite and
//    push capabilities, clear calendar/swap links. Runs after the hold is
//    committed, so nothing new can be admitted; it marks itself with a
//    transaction-local setting the guard recognises. Idempotent: an
//    already-held organization runs it again, so a failure here is repaired
//    by repeating the hold. Access is already stopped by held_at even before
//    this phase (requireAuth, login and capability checks read it).
export async function holdOrganization({ organizationId, actorId, confirm, acknowledgeExportWarning, lockTimeout = HOLD_LOCK_TIMEOUT }) {
  const client = await pool.connect()
  let already
  try {
    await client.query('BEGIN')
    // A queued FOR UPDATE also queues every later admission for this parish
    // behind it. Bound the wait (a recurring gift in flight holds admission
    // across its provider call) so a slow writer cannot stall the parish.
    await client.query("SELECT set_config('lock_timeout', $1, true)", [lockTimeout])
    const { rows: [org] } = await client.query('SELECT id, name, held_at FROM ochr_organizations WHERE id = $1 FOR UPDATE', [organizationId])
    if (!org) { await client.query('ROLLBACK'); return { status: 404, body: { error: 'Organization not found' } } }
    // Account operations take the admission lock first, so none is mid-flight
    // here: this read of the actor is stable.
    const { rows: [actor] } = await client.query(
      'SELECT role, closed_at, deactivated_at FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [actorId, organizationId]
    )
    if (!org.held_at && (!actor || actor.role !== 'admin' || actor.closed_at || actor.deactivated_at)) {
      await client.query('ROLLBACK')
      return { status: 403, body: { error: 'Only an active organization administrator can place this organization on hold.' } }
    }
    if (!org.held_at && (confirm !== org.name || acknowledgeExportWarning !== true)) {
      await client.query('ROLLBACK')
      return { status: 400, body: { error: 'Confirm the exact organization name and acknowledge that an export must be obtained before access is stopped.' } }
    }
    already = !!org.held_at
    if (!already) {
      await client.query(
        'UPDATE ochr_organizations SET held_at = NOW(), held_by = $2, kiosk_token = NULL, page_published = FALSE WHERE id = $1',
        [organizationId, actorId]
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err?.code === '55P03') {
      return { status: 503, body: { error: 'Other work for this organization is still finishing. Nothing was changed; try again in a moment.' } }
    }
    throw err
  } finally {
    client.release()
  }

  // The hold is committed: access is already refused everywhere that reads
  // held_at. Revocation cleans up the capabilities behind it; retry a few
  // times, and if it still fails, say so instead of claiming it happened.
  let revocationComplete = false
  for (let attempt = 1; attempt <= 3 && !revocationComplete; attempt++) {
    try {
      await revokeHeldAccess(organizationId)
      revocationComplete = true
    } catch (err) {
      monitor.error('organization.hold.revocation', err, { orgId: organizationId, attempt })
    }
  }

  return { status: 200, body: {
    held: true, already, access_revoked: true,
    // false: logins, links and subscriptions were not all cleaned up yet.
    // They are unusable while held (every path checks held_at); an operator
    // can re-run the cleanup (POST /api/admin/maintenance/organizations/:id/hold-revocation).
    revocation_complete: revocationComplete,
    parish_history_retained: true, organization_deleted: false,
    provider_status: 'not_contacted', backup_status: 'not_erased',
    all_copies_erased: false,
  } }
}

export async function revokeHeldAccess(organizationId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [org] } = await client.query('SELECT held_at FROM ochr_organizations WHERE id = $1', [organizationId])
    if (!org?.held_at) throw new Error('revocation runs only for a held organization')
    await client.query("SELECT set_config('ochr.hold_revocation_org', $1, true)", [String(organizationId)])
    await client.query(
      `UPDATE ochr_users
          SET deactivated_at = COALESCE(deactivated_at, NOW()),
              token_version = COALESCE(token_version, 1) + 1
        WHERE organization_id = $1`,
      [organizationId]
    )
    await client.query('DELETE FROM ochr_password_reset_tokens WHERE user_id IN (SELECT id FROM ochr_users WHERE organization_id = $1)', [organizationId])
    await client.query('DELETE FROM ochr_push_subscriptions WHERE organization_id = $1', [organizationId])
    await client.query('UPDATE ochr_clients SET calendar_token = NULL, swap_token = NULL WHERE organization_id = $1 AND (calendar_token IS NOT NULL OR swap_token IS NOT NULL)', [organizationId])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
