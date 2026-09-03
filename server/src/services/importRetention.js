// Staged-row retention for the Migration Studio (MIG.1.1).
//
// The Studio stages every parsed row so a person can see what will happen
// before it happens. Thirty days after the import finished or closed,
// that staging is no longer review material — it is a second copy of the
// parish's roster or giving history, sitting in a table nobody opens.
//
// What goes:      ochr_import_rows for that batch — raw and normalized.
// What stays:     the batch, the receipt, the source name and kind, the
//                 mapping and its summary, the aggregate counts, the
//                 follow-up reasons, who prepared it, who approved it,
//                 the audit history, and every record the import created.
//
// The batch is NOT relabelled. Its status still says what happened to the
// import — committed, abandoned — because that is what somebody will look
// for a year later. `rows_purged_at` is a separate fact about the staging,
// and the interface reads it to answer "can I still see row 412?".
//
// Three properties this has to hold, and each is asserted by a test:
//
//   tenant-safe   every delete is scoped to (batch_id, organization_id)
//                 taken from the batch row itself. One parish's prune can
//                 never reach another's rows, even for a batch id that
//                 collides.
//   idempotent    a purged batch has rows_purged_at set and is never
//                 revisited. Running the prune twice in a minute does
//                 nothing the second time.
//   auditable     each purge writes an audit row for that parish, so the
//                 disappearance of the staging is itself in the record.
//
// Deliberately NOT deleted here: batches whose rows are gone, empty
// batches, or anything belonging to a parish that no longer exists (the
// organization cascade already took those).

import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { IMPORT_ROWS_RETENTION_DAYS } from '../routes/imports.js'

export async function pruneImportRows({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - IMPORT_ROWS_RETENTION_DAYS * 86400000)

  // The clock runs from the last thing that happened to the import: the
  // commit for a finished one, the last activity for one abandoned or
  // left uncommitted. A batch someone is still working on today does not
  // expire because it was uploaded five weeks ago.
  const { rows: due } = await pool.query(
    `SELECT id, organization_id, status,
            COALESCE(committed_at, updated_at, created_at) AS anchor
       FROM ochr_import_batches
      WHERE rows_purged_at IS NULL
        AND COALESCE(committed_at, updated_at, created_at) < $1
      ORDER BY id`,
    [cutoff.toISOString()]
  )

  let batchesPurged = 0
  let rowsPurged = 0

  for (const batch of due) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Re-read under a lock. Between the scan and here somebody may have
      // re-run a mapping, which moves updated_at forward and takes the
      // batch back out of scope — purging it anyway would delete rows a
      // person is looking at right now.
      const { rows: [locked] } = await client.query(
        `SELECT id, organization_id, rows_purged_at,
                COALESCE(committed_at, updated_at, created_at) AS anchor
           FROM ochr_import_batches
          WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [batch.id, batch.organization_id]
      )
      if (!locked || locked.rows_purged_at || new Date(locked.anchor) >= cutoff) {
        await client.query('ROLLBACK')
        continue
      }

      // Both halves of the composite key. The batch id alone would be
      // enough given the FK, and that is exactly the assumption worth not
      // making in a job that runs unattended across every parish.
      const { rowCount } = await client.query(
        `DELETE FROM ochr_import_rows
          WHERE batch_id = $1 AND organization_id = $2`,
        [locked.id, locked.organization_id]
      )

      await client.query(
        `UPDATE ochr_import_batches
            SET rows_purged_at = NOW(), rows_purged_count = $3, updated_at = updated_at
          WHERE id = $1 AND organization_id = $2`,
        [locked.id, locked.organization_id, rowCount]
      )

      // The staging vanishing is itself an event in the parish's history.
      // user_id is null: nobody did this, a policy did, and saying so is
      // more useful than attributing it to whoever last touched the batch.
      await client.query(
        `INSERT INTO ochr_audit_log
           (organization_id, user_id, user_name, action, entity_type, entity_id,
            summary, metadata)
         VALUES ($1, NULL, 'OpenChurch retention policy', 'delete', 'import_batch', $2, $3, $4)`,
        [
          locked.organization_id, String(locked.id),
          `Removed ${rowCount} staged row(s) from import #${locked.id} after ${IMPORT_ROWS_RETENTION_DAYS} days. The receipt and its counts were kept.`,
          JSON.stringify({ rows_purged: rowCount, retention_days: IMPORT_ROWS_RETENTION_DAYS, policy: 'import_staged_rows' }),
        ]
      )

      await client.query('COMMIT')
      batchesPurged++
      rowsPurged += rowCount
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      // One parish's failure must not stop the sweep for the rest.
      monitor.error('retention.importRows', err, { batchId: batch.id, orgId: batch.organization_id })
    } finally {
      client.release()
    }
  }

  return { importBatchesPurged: batchesPurged, importRowsPurged: rowsPurged }
}
