// Live schema introspection for the vault.
//
// The alternative — a hand-written list of which tables cascade from
// which — is a list that goes stale the first time somebody adds a
// migration and forgets this file. A snapshot built from a stale list
// under-captures silently, which is the exact failure the vault exists to
// prevent. So the graph is read from the database that is about to
// perform the delete.
//
// Cached for the life of the process: migrations run at boot, before the
// first delete, and the schema does not change under a running server.

import pool from '../db.js'

let columnsCache = null
let fkCache = null

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/

export function assertIdent(name) {
  if (!SAFE_IDENT.test(String(name))) throw new Error(`unsafe identifier: ${name}`)
  return name
}

// table → { name → { type, generated } }
export async function columns(conn = pool) {
  if (columnsCache) return columnsCache
  const { rows } = await conn.query(`
    SELECT table_name, column_name, data_type, is_generated
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name LIKE 'ochr\\_%' ESCAPE '\\'`)
  const out = {}
  for (const r of rows) {
    ;(out[r.table_name] ||= {})[r.column_name] = {
      type: r.data_type,
      generated: r.is_generated !== 'NEVER',
    }
  }
  columnsCache = out
  return out
}

// parent table → [{ child, column, onDelete }] where onDelete is
// 'cascade' | 'setnull' | 'other'. Only single-column references to the
// parent's `id` are followed; the composite tenant keys added by
// migration 071 reference (id, organization_id), so the id half is the
// edge and organization_id rides along.
export async function foreignKeys(conn = pool) {
  if (fkCache) return fkCache
  const { rows } = await conn.query(`
    SELECT child.relname  AS child_table,
           parent.relname AS parent_table,
           con.confdeltype AS on_delete,
           (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS child_cols,
           (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS parent_cols
      FROM pg_constraint con
      JOIN pg_class child  ON child.oid  = con.conrelid
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace n  ON n.oid = child.relnamespace
     WHERE con.contype = 'f'
       AND n.nspname = 'public'
       AND child.relname LIKE 'ochr\\_%' ESCAPE '\\'`)

  const kindOf = { c: 'cascade', n: 'setnull' }
  const RANK = { cascade: 2, setnull: 1, other: 0 }
  const out = {}
  for (const r of rows) {
    const i = (r.parent_cols || []).indexOf('id')
    if (i === -1) continue
    const column = r.child_cols[i]
    const onDelete = kindOf[r.on_delete] || 'other'
    // Migration 071 added composite tenant keys ALONGSIDE the original
    // single-column ones, so most columns arrive here twice. Deduplicate
    // on (child, column) and keep the stronger rule: if either
    // constraint cascades, the row goes, and the snapshot must contain
    // it.
    const list = (out[r.parent_table] ||= [])
    const existing = list.find(e => e.child === r.child_table && e.column === column)
    if (existing) {
      if (RANK[onDelete] > RANK[existing.onDelete]) existing.onDelete = onDelete
      continue
    }
    list.push({ child: r.child_table, column, onDelete })
  }
  fkCache = out
  return out
}

// Test seam. Two databases in one process (fresh vs dev) would otherwise
// share the first one's schema.
export function resetSchemaCache() { columnsCache = null; fkCache = null }
