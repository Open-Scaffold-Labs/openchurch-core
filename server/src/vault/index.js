// The Continuity Vault — capture before deletion, restore on request.
//
// The promise, exactly: a protected delete does not destroy anything for
// RETENTION_DAYS. Not "nothing is ever lost" — that sentence is not
// earned until the backup architecture and restore drills prove it.
//
// A capture holds three things, and the third is the one people forget:
//
//   roots     the row or rows the delete named
//   cascaded  every row the database would have deleted with them
//   relinks   every row that would have SURVIVED with a NULL where the
//             reference used to be
//
// ROOTS IS A LIST, and that is the whole of multi-root capture. Some
// deletes name more than one row: "delete this whole recurring series"
// removes twenty-six occurrences in one statement, and none of them is
// the parent of the others in any sense a user would recognise — they
// are siblings. Capturing one and cascading the rest would restore the
// series as children of an occurrence, which is not what was deleted.
// So the entry holds every named row, and a restore puts them all back
// or none of them.
//
// A relink therefore has to remember WHICH root it pointed at. With one
// root that was implicit; with twenty-six it is the difference between
// a Mass intention returning to its own Tuesday and returning to the
// first Tuesday of the series. Entries written before this carry no
// `to` and are read as pointing at the only root they had.
//
// Without relinks, restoring a member gives you her record back and
// leaves her baptism pointing at nobody, her pledge unattached, her group
// with no leader. The row would be recovered and the memory would not.
//
// Restoring never overwrites. A relink is only re-applied where the
// column is still NULL, so a leader appointed in the meantime keeps the
// group, and the entry says what it could not put back.

import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { sanitizeRow, sanitizeSnapshot } from '../services/credentialSanitize.js'
import { PROTECTED, RETENTION_DAYS, MAX_CAPTURED_ROWS } from './registry.js'
import { columns, foreignKeys, assertIdent } from './schema.js'

export class VaultError extends Error {
  constructor(code, message, status = 409, extra = undefined) {
    super(message); this.code = code; this.status = status
    this.extra = extra && typeof extra === 'object' ? extra : undefined
  }
}

export function vaultErrorPayload(err) {
  return { error: err.message, code: err.code, ...(err.extra || {}) }
}

const q = t => `"${assertIdent(t)}"`

async function hasOrgColumn(table) {
  const cols = await columns()
  return Boolean(cols[table]?.organization_id)
}

// Columns we can put back. Generated columns are recomputed by Postgres
// and must not appear in the INSERT; a column dropped since capture is
// skipped rather than fatal, because a restore that fails because the
// schema moved on is a restore that does not exist.
async function insertableColumns(table, row) {
  const cols = (await columns())[table] || {}
  return Object.keys(row).filter(k => cols[k] && !cols[k].generated)
}

// node-pg turns a JS object into a Postgres array literal unless the
// target is json/jsonb, and turns a JS array into an array literal
// always. Both are wrong for a jsonb column, so serialise by the column's
// declared type rather than by the value's JS shape.
async function bindValues(table, row, keys) {
  const cols = (await columns())[table] || {}
  return keys.map(k => {
    const v = row[k]
    if (v === null || v === undefined) return null
    const t = cols[k]?.type
    if (t === 'jsonb' || t === 'json') return JSON.stringify(v)
    return v
  })
}

// ── capture ──────────────────────────────────────────────────────────────

// Walk the cascade graph from every named root, collecting everything the
// delete would take and everything it would orphan. Breadth-first, so
// rows come back in an order that inserts parents before children.
//
// `seen` is seeded with all the roots, which is what stops a sibling
// being captured twice. A recurring series is held together by a
// self-referencing FK: walking the seed finds every other occurrence as
// a cascade child. Those occurrences are roots in their own right, so
// they must not ALSO appear in `cascaded` — a restore would then try to
// insert them twice and the second insert would collide on the primary
// key.
async function walk(conn, table, ids, orgId) {
  const fks = await foreignKeys()
  const cascaded = []          // [{ table, row }] in insert order
  const relinks  = []          // [{ table, column, to, ids }]
  const seen = new Set(ids.map(id => `${table}:${id}`))
  const queue = ids.map(id => [table, id])
  // The roots count against the ceiling too. Twenty-six occurrences that
  // drag five thousand check-ins is the case the ceiling exists for, and
  // counting only the children would let it through.
  let rowCount = ids.length

  while (queue.length) {
    const [t, rid] = queue.shift()
    for (const edge of fks[t] || []) {
      const childOrg = await hasOrgColumn(edge.child)
      const where = `WHERE ${q(edge.column)} = $1${childOrg ? ' AND organization_id = $2' : ''}`
      const params = childOrg ? [rid, orgId] : [rid]

      if (edge.onDelete === 'cascade') {
        const { rows } = await conn.query(`SELECT * FROM ${q(edge.child)} ${where}`, params)
        for (const row of rows) {
          const key = `${edge.child}:${row.id}`
          if (seen.has(key)) continue
          seen.add(key)
          if (++rowCount > MAX_CAPTURED_ROWS) {
            throw new VaultError('too_large',
              `This delete would remove more than ${MAX_CAPTURED_ROWS} related rows. ` +
              'That is a data migration, not a deletion — see docs/RECOVERY-RUNBOOK.md.', 422)
          }
          delete row.search_vec
          cascaded.push({ table: edge.child, row })
          if (row.id !== undefined) queue.push([edge.child, row.id])
        }
      } else if (edge.onDelete === 'setnull') {
        const { rows } = await conn.query(`SELECT id FROM ${q(edge.child)} ${where}`, params)
        if (rows.length) {
          // `to` is the row this reference pointed at — not necessarily
          // the first root. See the header note on multi-root relinks.
          relinks.push({ table: edge.child, column: edge.column, to: rid, ids: rows.map(r => r.id) })
        }
      }
    }
  }
  return { cascaded, relinks }
}

// CHK-05. A Mass (or the series/seed set that would disappear with it)
// that already has check-ins cannot go through capture-then-delete.
//
// The named roots are already locked FOR UPDATE. This locks every
// occurrence the seed would cascade as well, then counts. A concurrent
// check-in takes KEY SHARE on the event it names and so waits on that
// lock rather than inserting between the count and the delete — the
// TOCTOU Leo named (T0 count=0 → T1 check-in → T2 CASCADE-wipe).
// CASCADE stays; the lock-then-recheck is the gate. Changing the FK
// is a later authorized PR.
async function refuseEventIfAttendance(conn, rootIds, orgId) {
  const { rows: events } = await conn.query(
    `SELECT id FROM ochr_calendar_events
      WHERE organization_id = $2
        AND (id = ANY($1::int[]) OR recurrence_parent_id = ANY($1::int[]))
      ORDER BY id
      FOR UPDATE`,
    [rootIds, orgId]
  )
  const eventIds = events.map(r => r.id)
  if (!eventIds.length) return

  // attendance = DISTINCT_PEOPLE (reporting/definitions.js): a member
  // who checked out and returned is one person; guests still count
  // per row. checkin_count is the raw rows so that return is visible.
  const { rows: [att] } = await conn.query(
    `SELECT COUNT(*)::int AS checkin_count,
            COUNT(DISTINCT COALESCE(client_id::text, 'row:' || id::text))::int AS attendance,
            COUNT(DISTINCT calendar_event_id)::int AS events_with_attendance
       FROM ochr_checkins
      WHERE organization_id = $2 AND calendar_event_id = ANY($1::int[])`,
    [eventIds, orgId]
  )
  const checkinCount = att?.checkin_count ?? 0
  const people = att?.attendance ?? 0
  if (checkinCount > 0) {
    const who = people === 1 ? 'One person was' : `${people} people were`
    throw new VaultError(
      'has_attendance',
      `${who} checked in at this Mass. It was not erased.`,
      409,
      {
        checkin_count: checkinCount,
        attendance: people,
        events_with_attendance: att?.events_with_attendance ?? 0,
      },
    )
  }
}

function summarise(cascaded, relinks) {
  const counts = {}
  for (const c of cascaded) counts[c.table] = (counts[c.table] || 0) + 1
  const relinked = {}
  // One (table, column) can now appear once per root — a Mass intention
  // on each of twenty-six Tuesdays is twenty-six entries against
  // ochr_mass_intentions.calendar_event_id. Add them up rather than
  // letting the last one win, which would report 1 for a series of 26.
  for (const r of relinks) {
    const key = `${r.table}.${r.column}`
    relinked[key] = (relinked[key] || 0) + r.ids.length
  }
  return {
    cascaded_rows: cascaded.length,
    relinked_rows: Object.values(relinked).reduce((a, b) => a + b, 0),
    cascaded: counts,
    relinked,
  }
}

// Capture, then delete, in one transaction. Either the parish loses the
// rows and the vault holds them, or neither happened.
//
// `ids` may name one row or many. Many is not a loop over one: the whole
// set has to be captured against a single consistent read, or a restore
// puts back a series that never existed in that shape.
//
// `conn` enlists this capture in a transaction the CALLER owns, instead of
// one of its own. Import undo needs that: it vaults every record the import
// created and then marks the batch undone, and those two facts have to become
// true together. Without it the batch update sits outside the vault's
// transaction, so a process that dies in the gap leaves the records vaulted
// and the batch still reading "can undo" — the next click finds everything
// already gone and writes a receipt claiming it removed nothing.
//
// When a caller passes `conn`, it owns BEGIN, COMMIT, ROLLBACK and release;
// this function does none of them. It still throws on failure, which is how
// the caller learns to roll back.
export async function captureAndDeleteMany({ kind, ids, orgId, user = null, reason = null, conn: external = null }) {
  const spec = PROTECTED[kind]
  if (!spec) throw new VaultError('not_protected', `${kind} is not a protected kind`, 500)

  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number))]
    .filter(n => Number.isInteger(n) && n > 0)
  if (!wanted.length) return null

  const conn = external ?? await pool.connect()
  const owns = !external
  try {
    if (owns) await conn.query('BEGIN')

    // ORDER BY id so the snapshot is stable and the seed of a series —
    // always the lowest id, since it is inserted first — leads.
    const { rows: roots } = await conn.query(
      `SELECT * FROM ${q(spec.table)}
        WHERE id = ANY($1::int[]) AND organization_id = $2
        ORDER BY id FOR UPDATE`,
      [wanted, orgId]
    )
    // Nothing to capture. On our own transaction that means roll back; on a
    // borrowed one it must NOT — the caller may have already done work in it,
    // and rolling back here would silently discard it. Returning null is the
    // signal; the caller decides.
    if (!roots.length) {
      if (owns) await conn.query('ROLLBACK')
      return null
    }
    for (const root of roots) delete root.search_vec

    const rootIds = roots.map(r => r.id)
    if (kind === 'event') await refuseEventIfAttendance(conn, rootIds, orgId)
    const { cascaded, relinks } = await walk(conn, spec.table, rootIds, orgId)
    const summary = { ...summarise(cascaded, relinks), roots: roots.length }

    const retention = new Date()
    retention.setUTCDate(retention.getUTCDate() + RETENTION_DAYS)

    const label = roots.length > 1 && spec.groupLabel
      ? spec.groupLabel(roots)
      : spec.label(roots[0])

    const { rows: [entry] } = await conn.query(
      `INSERT INTO ochr_vault_entries
         (organization_id, kind, entity_table, entity_id, label, snapshot, summary,
          reason, deleted_by, deleted_by_name, deleted_by_email, retention_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, label, retention_until`,
      [
        orgId, kind, spec.table, String(roots[0].id), label,
        // New snapshots do not keep a second copy of a bearer token.
        // Rows already stored are left untouched; export and restore strip
        // those on the way out and on the way back in.
        JSON.stringify(sanitizeSnapshot(spec.table, { roots, cascaded, relinks })), JSON.stringify(summary),
        reason, user?.id ?? null, user?.name ?? null, user?.email ?? null,
        retention.toISOString().slice(0, 10),
      ]
    )

    await conn.query(
      `DELETE FROM ${q(spec.table)} WHERE id = ANY($1::int[]) AND organization_id = $2`,
      [rootIds, orgId]
    )
    // Not `rowCount === roots.length`. Where the roots reference each
    // other — a series seed and its occurrences — deleting the seed
    // cascades the siblings away before the statement reaches them, and
    // rowCount comes back 1 for a delete that removed twenty-six rows.
    // The honest check is that nothing named survived.
    const { rows: survivors } = await conn.query(
      `SELECT 1 FROM ${q(spec.table)} WHERE id = ANY($1::int[]) LIMIT 1`,
      [rootIds]
    )
    if (survivors.length) throw new Error('vault: a named row survived the delete')

    if (owns) await conn.query('COMMIT')
    return {
      entry_id: entry.id, label: entry.label,
      retention_until: entry.retention_until, summary,
    }
  } catch (err) {
    if (owns) await conn.query('ROLLBACK').catch(() => {})
    if (err instanceof VaultError) throw err
    monitor.error('vault.capture', err, { kind, ids, orgId })
    throw err
  } finally {
    if (owns) conn.release()
  }
}

// The single-row spelling, which is most deletes. Kept as its own export
// so the six protected routes read the way they always did.
export async function captureAndDelete({ kind, id, orgId, user = null, reason = null }) {
  return captureAndDeleteMany({ kind, ids: [id], orgId, user, reason })
}

// ── restore ──────────────────────────────────────────────────────────────

export async function restoreEntry({ entryId, orgId, user = null }) {
  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')

    const { rows: [entry] } = await conn.query(
      `SELECT * FROM ochr_vault_entries
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [entryId, orgId]
    )
    if (!entry) { await conn.query('ROLLBACK'); return null }
    if (entry.restored_at) {
      await conn.query('ROLLBACK')
      throw new VaultError('already_restored',
        `This was already restored on ${new Date(entry.restored_at).toISOString().slice(0, 10)}.`)
    }

    const { cascaded = [], relinks = [] } = entry.snapshot
    // Entries written before multi-root capture hold a single `root`.
    // They are still inside their retention window and must still
    // restore, so read either shape.
    const roots = entry.snapshot.roots ?? (entry.snapshot.root ? [entry.snapshot.root] : [])
    if (!roots.length) {
      await conn.query('ROLLBACK')
      throw new VaultError('empty_snapshot', 'This entry has nothing to restore.', 422)
    }

    // Never overwrite what is there now. If any id has been taken back,
    // the parish has current information at that address and a restore
    // would silently replace it. All-or-nothing: half a series is worse
    // than none of it, because nobody can see which half is missing.
    const { rows: occupied } = await conn.query(
      `SELECT id FROM ${q(entry.entity_table)} WHERE id = ANY($1::int[])`,
      [roots.map(r => r.id)]
    )
    if (occupied.length) {
      await conn.query('ROLLBACK')
      throw new VaultError('occupied',
        'Something else already occupies this record. Restoring would overwrite current information.')
    }
    // The snapshot carries its own tenant, but a vault entry is only ever
    // read through its organization_id, so this is belt and braces
    // against a hand-edited row.
    if (roots.some(r => r.organization_id !== orgId)) {
      await conn.query('ROLLBACK')
      throw new VaultError('wrong_tenant', 'That record belongs to another organisation.', 403)
    }

    // Roots can reference each other — every occurrence of a series
    // points at the seed. Insert in an order that satisfies that, or the
    // first sibling fails on a foreign key to a seed that is not back
    // yet. No savepoints here: a root that cannot return is a failed
    // restore, not a footnote.
    for (const root of await orderRoots(entry.entity_table, roots)) {
      try {
        await insertRow(conn, entry.entity_table, root)
      } catch (err) {
        // Stage 6: a member whose contact data was minimized keeps a marker
        // (migration 114) that refuses an older snapshot carrying it back.
        // Say that, instead of a 500.
        if (err?.code === '23514' && /minimized/i.test(err.message ?? '')) {
          await conn.query('ROLLBACK')
          throw new VaultError('minimized',
            'This member\'s contact details were minimized. The saved copy cannot put them back.', 409)
        }
        throw err
      }
    }

    const skipped = []
    for (const { table, row } of cascaded) {
      try {
        await conn.query('SAVEPOINT child')
        await insertRow(conn, table, row)
        await conn.query('RELEASE SAVEPOINT child')
      } catch (err) {
        // A child whose OTHER parent has since been deleted cannot come
        // back, and must not take the whole restore down with it. Say so
        // instead of pretending.
        await conn.query('ROLLBACK TO SAVEPOINT child')
        skipped.push({ table, id: row.id, reason: err.code === '23503' ? 'its related record is gone' : 'could not be re-inserted' })
      }
    }

    let relinked = 0, notRelinked = 0
    for (const { table, column, ids, to } of relinks) {
      // `to` is absent on entries captured before multi-root, which by
      // definition had exactly one root to point back at.
      const target = to ?? roots[0].id
      const cols = (await columns())[table]
      if (!cols?.[column]) { notRelinked += ids.length; continue }
      const orgScoped = Boolean(cols.organization_id)
      const r = await conn.query(
        `UPDATE ${q(table)} SET ${q(column)} = $1
          WHERE id = ANY($2::int[]) AND ${q(column)} IS NULL
                ${orgScoped ? 'AND organization_id = $3' : ''}`,
        orgScoped ? [target, ids, orgId] : [target, ids]
      )
      relinked += r.rowCount
      notRelinked += ids.length - r.rowCount
    }

    await conn.query(
      `UPDATE ochr_vault_entries
          SET restored_at = NOW(), restored_by = $1, restored_by_name = $2
        WHERE id = $3`,
      [user?.id ?? null, user?.name ?? null, entryId]
    )

    await conn.query('COMMIT')
    return {
      entry_id: entry.id, kind: entry.kind, label: entry.label,
      restored: { records: roots.length, cascaded: cascaded.length - skipped.length, relinked },
      not_restored: { cascaded: skipped, relinked: notRelinked },
    }
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {})
    if (err instanceof VaultError) throw err
    monitor.error('vault.restore', err, { entryId, orgId })
    throw err
  } finally {
    conn.release()
  }
}

// Order roots so that one referencing another lands after it. Read from
// the live FK graph rather than hard-coded to recurrence_parent_id, so
// the next table that gets a self-reference is handled without anyone
// remembering this file exists. A row pointing at itself — which is how
// a series seed is marked — is not a dependency: Postgres accepts a
// self-reference inside the INSERT that creates it.
export async function orderRoots(table, roots) {
  const fks = await foreignKeys()
  const selfCols = (fks[table] || []).filter(e => e.child === table).map(e => e.column)
  if (selfCols.length === 0 || roots.length < 2) return roots

  const ids = new Set(roots.map(r => r.id))
  const placed = new Set()
  const ordered = []
  let pending = [...roots]

  for (let pass = 0; pass < roots.length && pending.length; pass++) {
    const blocked = []
    for (const row of pending) {
      const waitingOn = selfCols.some(c => {
        const v = row[c]
        return v != null && v !== row.id && ids.has(v) && !placed.has(v)
      })
      if (waitingOn) blocked.push(row)
      else { ordered.push(row); placed.add(row.id) }
    }
    if (blocked.length === pending.length) break   // a cycle among roots
    pending = blocked
  }
  // Anything left is part of a reference cycle; the database created it,
  // so it can hold it. Fall through in the original order rather than
  // dropping rows on the floor.
  return [...ordered, ...pending]
}

async function insertRow(conn, table, row) {
  // A restored member gets none of the old credential. calendar_token is
  // nullable. A fresh one is minted when an admin opens the member's
  // calendar link, and when a staff member opens their own feed
  // (GET /api/calendar-sync/my-link). swap_token is omitted too; a new
  // one exists only after an admin rotates it. Omitting a NOT NULL
  // credential with no default fails that child insert rather than
  // writing the stale secret back.
  const clean = sanitizeRow(table, row)
  const keys = await insertableColumns(table, clean)
  if (!keys.length) throw new Error(`vault: nothing insertable for ${table}`)
  const values = await bindValues(table, clean, keys)
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')
  await conn.query(
    `INSERT INTO ${q(table)} (${keys.map(q).join(', ')}) VALUES (${placeholders})`,
    values
  )
}

// ── reading ──────────────────────────────────────────────────────────────

export async function listEntries(orgId, { kind = null, includeRestored = false, limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, kind, entity_table, entity_id, label, summary, reason,
            deleted_at, deleted_by_name, deleted_by_email, retention_until,
            restored_at, restored_by_name
       FROM ochr_vault_entries
      WHERE organization_id = $1
        ${kind ? 'AND kind = $3' : ''}
        ${includeRestored ? '' : 'AND restored_at IS NULL'}
      ORDER BY deleted_at DESC
      LIMIT $2`,
    kind ? [orgId, limit, kind] : [orgId, limit]
  )
  return rows
}

export async function getEntry(orgId, entryId) {
  const { rows: [row] } = await pool.query(
    `SELECT id, kind, entity_table, entity_id, label, summary, reason,
            deleted_at, deleted_by_name, deleted_by_email, retention_until,
            restored_at, restored_by_name, snapshot
       FROM ochr_vault_entries
      WHERE organization_id = $1 AND id = $2`,
    [orgId, entryId]
  )
  return row || null
}

// The retention window, honoured. An entry past its stated date is
// removed — keeping it longer than the promise is its own kind of lie,
// and a parish that asked for a deletion is entitled to it eventually.
export async function pruneExpired({ now = new Date() } = {}) {
  const { rowCount } = await pool.query(
    `DELETE FROM ochr_vault_entries
      WHERE restored_at IS NULL AND retention_until < $1::date
        -- A held organization's writes are refused (migration 114); one held
        -- parish must not stop this promise being kept for every other one.
        -- Its entries stay as they stood when the hold was placed.
        AND organization_id IN (SELECT id FROM ochr_organizations WHERE held_at IS NULL)`,
    [now.toISOString().slice(0, 10)]
  )
  return { vaultEntriesPruned: rowCount }
}
