// Level B — permanent staff/login closure.
//
// The row stays. The personal name, email, avatar, and usable password
// do not. Sessions, reset links, invitations, and push subscriptions for
// this login die. Turning the login back on is refused. A later signup
// with the released email is a new person. This is not member removal
// and it does not close the parish.

import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { closureReviewReport } from './closureReview.js'
import { sqlEmailSha256 } from '../utils/emailNorm.js'
import {
  withLoginTransaction,
  lockLoginForAdminCount,
  countOtherActiveAdmins,
  cancelPendingNotificationsForLogin,
} from './loginDeactivation.js'

export const CLOSED_EMAIL_DOMAIN = 'login-closed.invalid'
export const FORMER_OPERATOR_LABEL = 'Former operator'

export const ONLY_ACTIVE_ADMIN_CLOSE =
  'Cannot close the only active admin. Transfer administration first. Closing the organization is a separate step and is not done here.'

export const CLOSED_LOGIN =
  'This login is closed. It cannot be turned back on.'

export const RESET_DOES_NOT_REOPEN =
  'This login is closed. A password reset does not turn it back on.'

export const INVITE_DOES_NOT_REOPEN =
  'This login is closed. An invitation does not turn it back on.'

export const PASSWORD_DOES_NOT_REOPEN =
  'This login is closed. Changing the password does not turn it back on.'

export const CLOSED_STAYS_CLOSED =
  'This login is closed. Turning it back on is not available.'

export function tombstoneEmail(userId) {
  const id = Number(userId)
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('A closed login needs its own id')
  }
  return `closed-user-${id}@${CLOSED_EMAIL_DOMAIN}`
}

export function isClosedEmail(email) {
  if (typeof email !== 'string') return false
  return email.trim().toLowerCase().endsWith(`@${CLOSED_EMAIL_DOMAIN}`)
}

// No vendor adapter is configured here. Saying the copies were deleted
// would be a false receipt.
export function providerCopyStatus() {
  return {
    status: 'unavailable',
    detail: 'No provider deletion adapter is configured in this environment.',
  }
}

export function backupCopyStatus() {
  return {
    status: 'not_in_this_environment',
    detail: 'Backup copies are outside this application and were not deleted.',
  }
}

function receiptFrom(row, already) {
  return {
    closed: true,
    already,
    access_revoked: row.access_revoked === true,
    live_profile_processed: row.live_profile_processed === true,
    review_remaining: row.review_remaining === true,
    provider_status: row.provider_status,
    backup_status: row.backup_status,
    all_copies_erased: false,
  }
}

async function readReceipt(client, organizationId, userId) {
  const { rows } = await client.query(
    `SELECT access_revoked, live_profile_processed, review_remaining,
            provider_status, backup_status, all_copies_erased
       FROM ochr_login_closures
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId]
  )
  if (!rows.length) {
    const provider = providerCopyStatus()
    const backup = backupCopyStatus()
    return {
      closed: true,
      already: true,
      access_revoked: true,
      live_profile_processed: true,
      review_remaining: true,
      provider_status: provider.status,
      backup_status: backup.status,
      all_copies_erased: false,
    }
  }
  return receiptFrom(rows[0], true)
}

async function countWhere(client, sql, params) {
  const { rows } = await client.query(sql, params)
  return rows[0]?.n ?? 0
}

export function closeLogin({ organizationId, targetId, closedBy }) {
  return withLoginTransaction(async (client) => {
    const { target, rows } = await lockLoginForAdminCount(client, organizationId, targetId)
    if (!target) return { status: 404, body: { error: 'User not found' } }
    if (target.closed_at) {
      return { status: 200, body: { ...await readReceipt(client, organizationId, targetId), ...await closureReviewReport(client, organizationId, targetId) } }
    }
    if (target.role === 'admin' && countOtherActiveAdmins(rows, targetId) === 0) {
      return { status: 409, body: { error: ONLY_ACTIVE_ADMIN_CLOSE } }
    }

    // The name this login carried, read before it is removed. Used only to
    // recognise generated audit summaries about this login (below).
    const { rows: [profile] } = await client.query(
      'SELECT name FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [targetId, organizationId]
    )

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
      [targetId, organizationId, closedBy ?? null, tombstoneEmail(targetId), hash]
    )
    if (!updated.length) {
      return { status: 200, body: await readReceipt(client, organizationId, targetId) }
    }

    await client.query(
      `UPDATE ochr_password_reset_tokens
          SET used_at = NOW()
        WHERE user_id = $1 AND used_at IS NULL`,
      [targetId]
    )
    // F-06: a closed login must not keep receiving mail queued before
    // closure. Match on id AND the pre-closure address, this org only.
    await cancelPendingNotificationsForLogin(client, organizationId, targetId, target.email, 'login closed')
    // ARG-V2-1 (PR6): closure tombstones the address, so mail queued LATER
    // by address only can no longer be matched to this login. Remember an
    // unsalted SHA-256 of the former address (same normalisation as every
    // other recipient match). Not anonymisation: a guessed address can be
    // confirmed, and an offline dictionary attack can recover it; see the
    // privacy note in migration 119. Dispatch admission (transport.js recipientInactive)
    // refuses it until a live login in this org holds the address again.
    // F3: DO NOTHING keeps the FIRST closure time; nothing reads a last-closed
    // time. No backfill: logins closed before migration 119 have no row.
    if (target.email) {
      await client.query(
        `INSERT INTO ochr_closed_address_suppressions (organization_id, email_sha256)
         VALUES ($1, ${sqlEmailSha256('$2::text')})
         ON CONFLICT (organization_id, email_sha256) DO NOTHING`,
        [organizationId, target.email]
      )
    }
    await client.query(
      `UPDATE ochr_push_subscriptions
          SET removed_at = NOW()
        WHERE organization_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [organizationId, targetId]
    )
    await client.query(
      `UPDATE ochr_audit_log
          SET user_email = NULL, user_name = NULL
        WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, targetId]
    )
    const subject = await minimizeSubjectCopies(client, organizationId, targetId, profile?.name)
    await client.query(
      `UPDATE ochr_feedback_ledger
          SET user_email = NULL
        WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, targetId]
    )

    const retained = [
      {
        kind: 'audit_subject_text',
        n: subject.unmatched,
        note: 'Linked audit text and retained details need review. The live receipt measures these candidates again on read.',
      },
      {
        kind: 'audit_ip',
        n: await countWhere(
          client,
          `SELECT COUNT(*)::int AS n FROM ochr_audit_log
            WHERE organization_id = $1 AND user_id = $2 AND ip_address IS NOT NULL`,
          [organizationId, targetId]
        ),
        note: 'The network address on the operational log was left in place.',
      },
      {
        kind: 'amendment_snapshot',
        n: await countWhere(
          client,
          `SELECT COUNT(*)::int AS n FROM ochr_sacrament_amendments
            WHERE organization_id = $1 AND amended_by = $2`,
          [organizationId, targetId]
        ),
        note: 'Register correction authorship was not rewritten.',
      },
      {
        kind: 'vault_snapshot',
        n: await countWhere(
          client,
          `SELECT COUNT(*)::int AS n FROM ochr_vault_entries
            WHERE organization_id = $1 AND deleted_by = $2`,
          [organizationId, targetId]
        ),
        note: 'Vault actor snapshots were not rewritten.',
      },
      {
        kind: 'timeline_actor',
        n: await countWhere(
          client,
          `SELECT COUNT(*)::int AS n FROM ochr_parish_timeline
            WHERE actor_user_id = $2
              AND (diocese_org_id = $1 OR parish_org_id = $1)`,
          [organizationId, targetId]
        ),
        note: 'Parish timeline actor text was not rewritten.',
      },
      {
        kind: 'giving_statement_issuer',
        n: await countWhere(
          client,
          `SELECT COUNT(*)::int AS n FROM ochr_giving_statements
            WHERE organization_id = $1 AND issued_by = $2`,
          [organizationId, targetId]
        ),
        note: 'Issued giving statements were not rewritten.',
      },
    ]

    const provider = providerCopyStatus()
    const backup = backupCopyStatus()
    const reviewRemaining = retained.some(item => item.n > 0) || provider.status !== 'cleared'

    for (const item of retained) {
      await client.query(
        `INSERT INTO ochr_login_closure_reviews
           (organization_id, user_id, kind, row_count, disposition, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          organizationId,
          targetId,
          item.kind,
          item.n,
          item.n > 0 ? 'retained_for_review' : 'none_found',
          item.note,
        ]
      )
    }
    await client.query(
      `INSERT INTO ochr_login_closure_reviews
         (organization_id, user_id, kind, row_count, disposition, note)
       VALUES ($1, $2, 'unmapped_text', 0, 'not_measured', $3),
              ($1, $2, 'provider', 0, $4, $5),
              ($1, $2, 'backup', 0, $6, $7)`,
      [
        organizationId,
        targetId,
        'Unmapped text has not been attributed or counted. This stored zero is not a measured residue count.',
        provider.status,
        provider.detail,
        backup.status,
        backup.detail,
      ]
    )

    const body = {
      closed: true,
      already: false,
      access_revoked: true,
      live_profile_processed: true,
      review_remaining: reviewRemaining,
      provider_status: provider.status,
      backup_status: backup.status,
      all_copies_erased: false,
    }
    await client.query(
      `INSERT INTO ochr_login_closures
         (organization_id, user_id, closed_by, access_revoked, live_profile_processed,
          review_remaining, provider_status, backup_status, all_copies_erased)
       VALUES ($1, $2, $3, TRUE, TRUE, $4, $5, $6, FALSE)`,
      [organizationId, targetId, closedBy ?? null, reviewRemaining, provider.status, backup.status]
    )
    return { status: 200, body: { ...body, ...await closureReviewReport(client, organizationId, targetId) } }
  }, { organizationId })
}

// Audit rows ABOUT this login (entity user, entity_id = this id) carry copies
// of its profile: the request body that created, invited, or edited the
// login is stored in metadata (name, email, avatar), and the generated
// summary embeds the name ("Created user: Ana Diaz"). The actor scrub above
// only covers rows the person WROTE. Mapping here is reliable without
// guessing: the row's entity is this login, and only exact generated
// summaries are touched — "<Verb> user: <name>" where <name> is the copy in
// that same row's metadata or the login's own name at closure. Other text
// is left as written and counted for review. The row, its action, actor,
// entity, time, and every other metadata key stay. Older rows written
// against a zero-padded id ("007") are matched on the canonical id.
async function minimizeSubjectCopies(client, organizationId, targetId, currentName) {
  const id = String(targetId)
  const name = typeof currentName === 'string' && currentName.trim() ? currentName : null
  const scope = `organization_id = $1 AND entity_type = 'user'
                 AND entity_id ~ '^[0-9]+$' AND ltrim(entity_id, '0') = $2`
  const { rowCount: summaries } = await client.query(
    `UPDATE ochr_audit_log
        SET summary = regexp_replace(summary, '^(Created|Updated|Deleted) user: .*$', '\\1 user #' || $2)
      WHERE ${scope}
        AND (
          summary IN ('Created user: ' || (metadata->>'name'),
                      'Updated user: ' || (metadata->>'name'),
                      'Deleted user: ' || (metadata->>'name'))
          OR ($3::text IS NOT NULL AND
              summary IN ('Created user: ' || $3, 'Updated user: ' || $3, 'Deleted user: ' || $3))
        )`,
    [organizationId, id, name]
  )
  const { rowCount: metadataRows } = await client.query(
    `UPDATE ochr_audit_log
        SET metadata = metadata - 'name' - 'email' - 'avatar'
      WHERE ${scope}
        AND metadata ?| ARRAY['name', 'email', 'avatar']`,
    [organizationId, id]
  )
  const report = await closureReviewReport(client, organizationId, targetId)
  return { summaries, metadataRows, unmatched: report.reviews.find(r => r.kind === 'audit_subject_text').row_count }
}

export async function closureReceipt(client, organizationId, userId) {
  const { rows: users } = await client.query(
    `SELECT id, closed_at FROM ochr_users
      WHERE id = $1 AND organization_id = $2`,
    [userId, organizationId]
  )
  if (!users.length) return { status: 404, body: { error: 'User not found' } }
  if (!users[0].closed_at) return { status: 404, body: { error: 'This login is not closed' } }
  const receipt = await readReceipt(client, organizationId, userId)
  const report = await closureReviewReport(client, organizationId, userId)
  return {
    status: 200,
    body: { ...receipt, already: true, ...report },
  }
}
