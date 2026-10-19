// Daily retention prune. Three categories of growth-unbounded
// tables, each with its own appropriate policy:
//
//   ochr_audit_log + ochr_notification_log → per-plan window
//     (free=30d, pro=365d). Org-visible operational logs that the
//     admin paid for / agreed to.
//
//   ochr_ai_usage → fixed 90 days. Quota math only ever needs the
//     current calendar month; 90 days is a safety margin so the
//     monthly counter is never wrong even if the prune is paused
//     for a few weeks.
//
//   ochr_scheduled_notifications → fixed 30 days, ONLY on rows
//     whose status is sent/failed/cancelled. Pending rows are
//     never pruned regardless of age — that would be losing work.
//
//   ochr_import_rows → Migration Studio staging, 30 days after the
//     import finished or closed (MIG.1.1). The rows are the parish's
//     roster or giving history in a second place; the receipt, counts,
//     reasons and audit history are kept permanently. See
//     services/importRetention.js.
//
//   ochr_checkins → child-data safety (CHK.3). Spent/abandoned
//     pickup-code hashes are cleared after 2 days; check-in PII
//     (minors'/guests' names, guardian names) is anonymized after
//     400 days while the row survives for attendance counts.
//
// Skipped on purpose:
//   ochr_ai_generations → user-owned content (sermons!). The
//     Library page depends on it. Forever.
//   ochr_clients / ochr_events / etc → user data, never auto-pruned.
//
//   ochr_sacrament_amendments → NEVER pruned, deliberately. It is register
//   history, not operational telemetry. The register itself is permanent,
//   so a change history that expired after 30 days on Free would leave a
//   corrected entry with no record of what it used to say — which is the
//   defect migration 073 exists to close. If a retention pass is ever
//   added for this table, that is a bug.
//
// Idempotent: running twice in the same minute is a no-op on the
// second run. Returns counts so an operator (or cron run log) can
// see what happened.

import pool from '../db.js'
import { getPlan } from '../billing/plans.js'
import { pruneExpired as pruneVault } from '../vault/index.js'
import { pruneImportRows } from './importRetention.js'
import { monitor } from '../monitoring/index.js'
import { isHoldRefusal } from '../auth/organizationHold.js'

const AI_USAGE_RETENTION_DAYS         = 90
const SCHEDULED_NOTIFS_RETENTION_DAYS = 30
const SCHEDULED_NOTIFS_PRUNABLE_STATUSES = ['sent', 'failed', 'cancelled']

// Child-data safety (CHK.3 hardening). A pickup-code hash is only useful
// while the child is still in the room; anything older than this is a spent
// or abandoned code and is cleared. Check-in PII (names) is anonymized after
// a longer window — long enough to keep a year-plus of attendance analytics
// (the row, kind, and timestamps survive), short enough that minors' and
// guests' names don't sit in the database forever.
const CHECKIN_CODE_STALE_DAYS   = 2
const CHECKIN_PII_RETENTION_DAYS = 400
// Migration 114's held-organization redaction path admits exactly this value.
export const CHECKIN_REDACTED_NAME = 'Redacted'

export async function pruneOldRecords({ now = new Date() } = {}) {
  let orgsScanned = 0
  let auditPruned = 0
  let notificationLogPruned = 0
  let aiUsagePruned = 0
  let scheduledPruned = 0
  let checkinCodesCleared = 0
  let checkinPiiAnonymized = 0
  const redactionFailures = []

  try {
    // Every organization is listed. A held organization's ordinary history
    // is retained as it stood when the hold was placed (no audit/log/AI/
    // queue pruning; migration 114 refuses those writes anyway), but the
    // child-data redaction keeps running for it: a hold must not suspend
    // that privacy promise. See redactCheckins().
    const { rows: orgs } = await pool.query(
      'SELECT id, plan, held_at FROM ochr_organizations ORDER BY id'
    )

    for (const org of orgs) {
      orgsScanned++
      if (org.held_at == null) {
        // A hold placed after the list above was read refuses this org's
        // writes mid-run; skip the rest of its pruning and keep going.
        try {
          const plan = getPlan(org.plan)
          const days = plan?.limits?.retention_days ?? 30
          // Compute cutoff in JS rather than NOW() - INTERVAL so the
          // `now` injection point in tests works naturally.
          const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

          // Per-plan: audit log
          const auditRes = await pool.query(
            `DELETE FROM ochr_audit_log
              WHERE organization_id = $1 AND created_at < $2`,
            [org.id, cutoff.toISOString()]
          )
          auditPruned += auditRes.rowCount

          // Per-plan: notification log
          const notifRes = await pool.query(
            `DELETE FROM ochr_notification_log
              WHERE organization_id = $1 AND created_at < $2`,
            [org.id, cutoff.toISOString()]
          )
          notificationLogPruned += notifRes.rowCount

          // Fixed 90d: AI usage. Only ever queried for the current
          // calendar month so older rows are dead weight.
          const aiCutoff = new Date(now.getTime() - AI_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
          const aiRes = await pool.query(
            `DELETE FROM ochr_ai_usage
              WHERE organization_id = $1 AND created_at < $2`,
            [org.id, aiCutoff.toISOString()]
          )
          aiUsagePruned += aiRes.rowCount

          // Fixed 30d: scheduled notifications, ONLY in terminal
          // states. Pending rows are work that hasn't been done yet
          // and must survive regardless of age.
          const schedCutoff = new Date(now.getTime() - SCHEDULED_NOTIFS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
          const schedRes = await pool.query(
            `DELETE FROM ochr_scheduled_notifications
              WHERE organization_id = $1
                AND status = ANY($2::text[])
                AND created_at < $3`,
            [org.id, SCHEDULED_NOTIFS_PRUNABLE_STATUSES, schedCutoff.toISOString()]
          )
          scheduledPruned += schedRes.rowCount

        } catch (err) {
          if (!isHoldRefusal(err)) throw err
          monitor.warn('retention.held_organization', `Organization ${org.id} was placed on hold during the run; pruning skipped, check-in redaction still applied.`)
        }
      }
      // One parish's failure must not stop child-data redaction for the
      // parishes after it; the run still reports the failure at the end.
      try {
        const redacted = await redactCheckins(org.id, { now })
        checkinCodesCleared += redacted.codesCleared
        checkinPiiAnonymized += redacted.piiAnonymized
      } catch (err) {
        monitor.error('retention.redact', err, { orgId: org.id })
        redactionFailures.push(org.id)
      }
    }

  } catch (err) {
    monitor.error('retention.prune', err)
    throw err
  }

  // The vault's own retention window. An entry kept past the date it
  // promised is not generosity — a parish that asked for a deletion is
  // entitled to it eventually, and a window nobody honours is not a
  // policy.
  let vaultPruned = 0
  try {
    ;({ vaultEntriesPruned: vaultPruned } = await pruneVault({ now }))
  } catch (err) {
    monitor.error('retention.vault', err)
  }

  // Migration Studio staging. The receipt, counts and audit history are
  // untouched — only the raw parsed rows go. See importRetention.js.
  let importBatches = 0, importRows = 0
  try {
    const r = await pruneImportRows({ now })
    importBatches = r.importBatchesPurged
    importRows = r.importRowsPurged
  } catch (err) {
    monitor.error('retention.imports', err)
  }

  // Reported after the vault and import pruning have run, so one parish's
  // redaction failure does not hold those back either.
  if (redactionFailures.length) {
    throw new Error(`Check-in redaction failed for ${redactionFailures.length} organization(s): ${redactionFailures.join(', ')}`)
  }

  return {
    orgs_scanned:             orgsScanned,
    audit_pruned:             auditPruned,
    notification_log_pruned:  notificationLogPruned,
    ai_usage_pruned:          aiUsagePruned,
    scheduled_pruned:         scheduledPruned,
    checkin_codes_cleared:    checkinCodesCleared,
    checkin_pii_anonymized:   checkinPiiAnonymized,
    vault_entries_pruned:     vaultPruned,
    import_batches_purged:    importBatches,
    import_rows_purged:       importRows,
  }
}

// The existing check-in redaction policy, for one organization, in its own
// transaction under the organization admission lock (KEY SHARE, the lock
// every tenant write takes). That lock makes the job and a HOLD serialize:
// a HOLD placed while this runs waits for it to commit; a HOLD committed
// first is seen here.
//
// A held organization's writes are refused (migration 114) except this one:
// the transaction marks itself for exactly this organization
// (ochr.checkin_redaction_org, transaction-local), and the guard then admits
// only UPDATEs of ochr_checkins that change nothing but the redaction
// columns, toward the redacted values (person_name -> CHECKIN_REDACTED_NAME,
// guardian_name -> NULL, security_code_hash -> NULL). No other table, no
// INSERT/DELETE, no other column. Parish access stays refused.
export async function redactCheckins(orgId, { now = new Date() } = {}) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [org] } = await client.query(
      'SELECT held_at FROM ochr_organizations WHERE id = $1 FOR KEY SHARE', [orgId])
    if (!org) { await client.query('ROLLBACK'); return { codesCleared: 0, piiAnonymized: 0 } }
    if (org.held_at != null) {
      await client.query("SELECT set_config('ochr.checkin_redaction_org', $1, true)", [String(orgId)])
    }
    // Child-data safety: clear spent pickup-code hashes. The row stays
    // (it's still attendance); only the now-useless code hash goes.
    // CRITICAL: only clear codes for children who have ALREADY been checked
    // out — never NULL the hash of a child still in the room, or checkout
    // would fall through the pickup gate and release them with no code
    // (fail-open). Checkout already nulls the hash, so this is a backstop;
    // any straggler in-flight hash is cleared later by the PII sweep below,
    // long after the child could still be waiting.
    const codeCutoff = new Date(now.getTime() - CHECKIN_CODE_STALE_DAYS * 24 * 60 * 60 * 1000)
    const codeRes = await client.query(
      `UPDATE ochr_checkins
          SET security_code_hash = NULL
        WHERE organization_id = $1
          AND security_code_hash IS NOT NULL
          AND checked_out_at IS NOT NULL
          AND checked_in_at < $2`,
      [orgId, codeCutoff.toISOString()]
    )

    // Child-data safety: anonymize old check-in PII (minors' and guests'
    // names, guardian names) past the retention window while keeping the
    // row for attendance counts. Idempotent — already-redacted rows are
    // skipped so re-runs don't inflate the count.
    const piiCutoff = new Date(now.getTime() - CHECKIN_PII_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const piiRes = await client.query(
      `UPDATE ochr_checkins
          SET person_name        = $3,
              guardian_name      = NULL,
              security_code_hash = NULL
        WHERE organization_id = $1
          AND checked_in_at < $2
          AND person_name <> $3`,
      [orgId, piiCutoff.toISOString(), CHECKIN_REDACTED_NAME]
    )
    await client.query('COMMIT')
    return { codesCleared: codeRes.rowCount, piiAnonymized: piiRes.rowCount }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
