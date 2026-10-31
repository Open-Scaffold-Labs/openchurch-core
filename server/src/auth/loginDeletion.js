// C3 — delete one signed-in person's own login inside a transaction the
// caller already opened.
//
// The caller locks in this order: organization KEY SHARE, then the
// deletion-request row, then lockLoginForAdminCount (target and active
// admins, id order). This function does not take those locks. The
// request row is before the user rows because the request's user
// foreign key shares the login row.
//
// Personal fields on the login row are cleared and the row stays, so a
// register correction or a ledger line that points at this id is not
// nulled by ON DELETE. Sessions die with token_version. Push tokens,
// notification preferences, reset links, and this login's native AI
// consent are deleted. Telemetry and audit actor ids are replaced with
// one tombstone UUID.
//
// CAROLINA-423 (review of 3de03850):
// - H2: rows this person only WROTE keep their summary and metadata (that
//   is somebody else's history, e.g. a client's name). Only the actor
//   columns change: user_id/user_email/user_name -> tombstone.
// - M1: rows ABOUT this login (entity user, this id) are minimized with
//   closure's minimizeSubjectCopies, and invited_by_name snapshots of
//   this person on logins they invited are cleared.
// - M2: the address-matched queue cancel skips record-addressed types.
// - M3: the deletion writes its own audit row, actor = tombstone.
// - L1: migration 131's trigger tombstones an audit/telemetry write that
//   lands after this commits.
//
// Sacramental rows, donation rows, refund rows, and ledger rows are not
// mentioned here. Voiding a gift is not a step in deletion.

import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { tombstoneEmail, minimizeSubjectCopies } from './loginClosure.js'
import { sqlEmailSha256 } from '../utils/emailNorm.js'
import { cancelPendingNotificationsForLogin } from './loginDeactivation.js'
import { RECORD_ADDRESSED_TYPES } from '../notifications/transport.js'

export const ONLY_ACTIVE_ADMIN_DELETE =
  'Cannot delete the only active admin. Transfer administration first. Closing the organization is a separate step and is not done here.'

async function tombstoneFor(client, organizationId, userId) {
  const { rows: [existing] } = await client.query(
    `SELECT tombstone_id FROM ochr_login_deletion_tombstones
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId])
  if (existing) return existing.tombstone_id
  const { rows: [inserted] } = await client.query(
    `INSERT INTO ochr_login_deletion_tombstones (organization_id, user_id, tombstone_id)
     VALUES ($1, $2, gen_random_uuid())
     ON CONFLICT (organization_id, user_id) DO NOTHING
     RETURNING tombstone_id`,
    [organizationId, userId])
  if (inserted) return inserted.tombstone_id
  const { rows: [again] } = await client.query(
    `SELECT tombstone_id FROM ochr_login_deletion_tombstones
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId])
  return again.tombstone_id
}

export async function fulfilLoginDeletion(client, { organizationId, userId, target }) {
  const tombstoneId = await tombstoneFor(client, organizationId, userId)

  // Read before the profile is cleared. Used only to recognise copies of
  // this person's own name (generated audit summaries, invited_by_name).
  const { rows: [profile] } = await client.query(
    'SELECT name, created_at FROM ochr_users WHERE id = $1 AND organization_id = $2',
    [userId, organizationId])
  let deletedNow = false

  if (!target.closed_at) {
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10)
    const { rows: updated } = await client.query(
      `UPDATE ochr_users
          SET closed_at = NOW(),
              closed_by = $3,
              deactivated_at = COALESCE(deactivated_at, NOW()),
              email = $4,
              name = '',
              avatar = NULL,
              password_hash = $5,
              token_version = COALESCE(token_version, 1) + 1
        WHERE id = $1
          AND organization_id = $2
          AND closed_at IS NULL
        RETURNING id`,
      [userId, organizationId, userId, tombstoneEmail(userId), hash])
    deletedNow = updated.length > 0
    if (updated.length && target.email) {
      await client.query(
        `INSERT INTO ochr_closed_address_suppressions (organization_id, email_sha256)
         VALUES ($1, ${sqlEmailSha256('$2::text')})
         ON CONFLICT (organization_id, email_sha256) DO NOTHING`,
        [organizationId, target.email])
      await cancelPendingNotificationsForLogin(client, organizationId, userId, target.email, 'login deleted',
        { skipRecordAddressedTypes: RECORD_ADDRESSED_TYPES })
    }
  }

  await client.query(
    `DELETE FROM ochr_push_subscriptions
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId])
  await client.query(
    `DELETE FROM ochr_notification_prefs WHERE user_id = $1`,
    [userId])
  await client.query(
    `DELETE FROM ochr_password_reset_tokens WHERE user_id = $1`,
    [userId])
  await client.query(
    `DELETE FROM ochr_native_ai_consents
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId])
  await client.query(
    `UPDATE ochr_feedback_ledger
        SET user_email = NULL
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId])

  await client.query(
    `UPDATE ochr_audit_log
        SET actor_tombstone_id = $3::uuid,
            user_id = NULL,
            user_email = NULL,
            user_name = NULL
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId, tombstoneId])
  await minimizeSubjectCopies(client, organizationId, userId, profile?.name)
  // invited_by_name is a name snapshot with no inviter id. Clear it only
  // where it can be attributed: same parish, exact name, invited after
  // this login existed, and no other open login in the parish carries
  // that name. Ambiguous snapshots are left as written.
  const name = typeof profile?.name === 'string' && profile.name.trim() ? profile.name : null
  if (name) {
    await client.query(
      `UPDATE ochr_users u
          SET invited_by_name = NULL
        WHERE u.organization_id = $1
          AND u.id <> $2
          AND u.invited_by_name = $3
          AND ($4::timestamptz IS NULL OR u.invited_at IS NULL OR u.invited_at >= $4::timestamptz)
          AND NOT EXISTS (
            SELECT 1 FROM ochr_users o
             WHERE o.organization_id = $1 AND o.id <> $2
               AND o.closed_at IS NULL AND o.name = $3)`,
      [organizationId, userId, name, profile?.created_at ?? null])
  }
  await client.query(
    `UPDATE ochr_ai_audit
        SET actor_tombstone_id = $3::uuid,
            actor_id = NULL
      WHERE organization_id = $1 AND actor_id = $2`,
    [organizationId, userId, tombstoneId])
  await client.query(
    `UPDATE ochr_ai_usage
        SET actor_tombstone_id = $3::uuid,
            user_id = NULL
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId, tombstoneId])

  // The deletion's own record. Written once, by the call that cleared the
  // profile, with the tombstone as actor and no personal fields.
  if (deletedNow) {
    await client.query(
      `INSERT INTO ochr_audit_log
         (organization_id, user_id, user_email, user_name, actor_tombstone_id,
          action, entity_type, entity_id, summary, metadata)
       VALUES ($1, NULL, NULL, NULL, $3::uuid, 'delete', 'user', $2::text, $4, $5::jsonb)`,
      [organizationId, String(userId), tombstoneId, `Deleted own login #${userId}`,
       JSON.stringify({ via: 'self_serve_deletion' })])
  }

  return tombstoneId
}
