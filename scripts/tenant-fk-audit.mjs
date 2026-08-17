#!/usr/bin/env node
// Tenant-FK audit (F2) — which org-scoped tables are protected by a
// composite foreign key, and which are still app-layer only.
//
// Background: the app scopes every query by req.organizationId, and does
// it well. A composite FK — REFERENCES parent(id, organization_id) — is
// the belt to that suspenders: it makes a cross-tenant row reference
// impossible at the database level, so one forgotten validator in a
// future route cannot silently create one. Migrations 044, 061 and
// 067–069 did this for some tables. This tells you which ones are left.
//
// Read-only. Run it against any environment:
//   node scripts/tenant-fk-audit.mjs
//
// Exit code: 0 when clean, 1 when a genuine gap exists. Migration 071
// closed the last of them, so this now runs in CI as a ratchet — a new
// single-column cross-tenant FK fails the build on the first commit.
//
// A reference is only a GAP when the child is itself org-scoped. Four
// children deliberately carry no organization_id — a pre-auth reset
// token, per-user notification prefs, payroll shifts, and a diocese
// affiliation that spans two organizations by definition. Those inherit
// their tenant through the parent row or have no tenant at all; adding
// the column would be denormalisation, not safety.
//
// One more is excluded by name: ochr_report_submissions.reviewed_by.
// The row belongs to the parish, the reviewer is a chancery user in
// another organization, and that crossing IS the review workflow. A
// composite FK there forbids the feature rather than protecting it.
//
// All of these are reported separately and never fail the build.

import pg from 'pg'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. Load server/.env first.')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: url })

const orgScoped = `
  SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND left(c.relname, 5) = 'ochr_'
     AND a.attname IN ('organization_id', 'diocese_org_id')
     AND NOT a.attisdropped
   ORDER BY 1`

// A BLIND SPOT THIS CLOSES.
//
// The first version of this script only recognised `organization_id` as a
// tenant key. The diocesan care tables (074) key on `diocese_org_id`
// instead — the tenant is the chancery, not the parish — so every one of
// them was silently classified "child carries no organization_id, by
// design" and skipped. The gate exited 0 on a set of tables it had not
// examined, which is the same failure as the LIKE 'ochr[_]%' bug on 08-14:
// a clean bill of health from a query looking at nothing.
//
// A table's tenant key is whichever of the two it actually carries.

// Every FK on an ochr_ table, with the columns it carries.
const fks = `
  SELECT con.conname                    AS constraint_name,
         src.relname                    AS child_table,
         tgt.relname                    AS parent_table,
         ARRAY(SELECT a.attname
                 FROM unnest(con.conkey) k
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k
              )::text[]                 AS child_cols
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
   WHERE con.contype = 'f'
     AND left(src.relname, 5) = 'ochr_'
   ORDER BY src.relname, con.conname`

const { rows: scoped } = await pool.query(orgScoped)
const scopedSet = new Set(scoped.map(r => r.table_name))
const { rows: allFks } = await pool.query(fks)

// A reference is "tenant-safe" when the parent is org-scoped AND the FK
// carries organization_id. A reference to a non-org-scoped parent
// (ochr_organizations itself, lookup tables) is fine as-is.
// Which column carries the tenant on this table. Read from the schema
// rather than guessed, so a third convention would fail loudly here rather
// than be quietly skipped.
const tenantColOf = new Map()
{
  const { rows } = await pool.query(`
    SELECT c.relname AS table_name, a.attname AS col
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND left(c.relname, 5) = 'ochr_'
       AND a.attname IN ('organization_id', 'diocese_org_id')
       AND NOT a.attisdropped`)
  // organization_id wins where a table somehow carries both.
  for (const r of rows) {
    if (r.col === 'organization_id' || !tenantColOf.has(r.table_name)) {
      tenantColOf.set(r.table_name, r.col)
    }
  }
}
const tenantCol = t => tenantColOf.get(t) ?? 'organization_id'

const relevant = allFks.filter(f =>
  scopedSet.has(f.parent_table) && f.parent_table !== 'ochr_organizations')

// A composite FK needs organization_id on BOTH sides. Where the child has
// no such column the constraint is not expressible, and that is by design.
const byDesign = relevant.filter(f => !scopedSet.has(f.child_table))

// Some FKs pair with a column that is not the table's own tenant key.
// ochr_diocese_affiliations.accepted_by is a PARISH user on a
// diocese-keyed row, so it is composite with parish_org_id — correct, and
// invisible to a rule that only knows about tenant columns.
const ALT_PAIRS = new Set(['ochr_diocese_affiliations.accepted_by'])

const safe = relevant.filter(f =>
  f.child_cols.includes(tenantCol(f.child_table)) ||
  f.child_cols.some(c => ALT_PAIRS.has(`${f.child_table}.${c}`)))

// 044 and 061 ADDED composite constraints without dropping the original
// single-column ones, so a protected reference often shows up twice.
// Counting the legacy row as a hole would make that work look undone.
//
// Keyed on the COLUMN, not just the child→parent pair. Keying on the pair
// was the first attempt and it was wrong in a way that mattered: a brand
// new single-column FK on a pair that happened to already have a
// composite one elsewhere was silently forgiven, so the ratchet could
// not fail. A gate that cannot fail is worse than no gate. Verified by
// adding a probe column and watching this exit 1.
const fkCol = f => f.child_cols.find(c => c !== tenantCol(f.child_table) && c !== 'parish_org_id') ?? f.child_cols[0]
const protectedRefs = new Set(safe.map(f => `${f.child_table}.${fkCol(f)}→${f.parent_table}`))
// Cross-organization by design — see migration 071's header.
const CROSS_ORG_BY_DESIGN = new Set(['ochr_report_submissions.reviewed_by'])

const risky = relevant.filter(f =>
  scopedSet.has(f.child_table) &&
  !f.child_cols.includes(tenantCol(f.child_table)) &&
  !f.child_cols.some(c => ALT_PAIRS.has(`${f.child_table}.${c}`)) &&
  !f.child_cols.some(c => CROSS_ORG_BY_DESIGN.has(`${f.child_table}.${c}`)) &&
  !protectedRefs.has(`${f.child_table}.${fkCol(f)}→${f.parent_table}`))

console.log(`\norg-scoped tables: ${scopedSet.size}`)
console.log(`cross-table FKs to an org-scoped parent: ${risky.length + safe.length}`)
console.log(`  composite (tenant-safe): ${safe.length}`)
console.log(`  single-column (app-layer only): ${risky.length}\n`)

if (safe.length) {
  console.log('Already protected:')
  for (const f of safe) console.log(`  ✓ ${f.child_table} → ${f.parent_table}  (${f.child_cols.join(', ')})`)
  console.log('')
}

if (risky.length) {
  console.log('Not yet protected — a composite FK here would make a')
  console.log('cross-tenant reference impossible rather than merely unlikely:\n')
  for (const f of risky) {
    console.log(`  · ${f.child_table} → ${f.parent_table}`)
    console.log(`      constraint: ${f.constraint_name}`)
    console.log(`      columns:    ${f.child_cols.join(', ')}`)
    const pc = tenantCol(f.parent_table)
    console.log(`      needs:      UNIQUE (id, ${pc}) on ${f.parent_table},`)
    console.log(`                  then REFERENCES ${f.parent_table}(id, ${pc})`)
  }
  console.log('')
} else {
  console.log('No unprotected cross-tenant references found.\n')
}

if (byDesign.length) {
  console.log('Not applicable — the child carries no organization_id, by design:')
  for (const f of byDesign) console.log(`  – ${f.child_table} → ${f.parent_table}`)
  console.log('')
}

const crossOrg = relevant.filter(f =>
  f.child_cols.some(c => CROSS_ORG_BY_DESIGN.has(`${f.child_table}.${c}`)))
if (crossOrg.length) {
  console.log('Cross-organization by design — a composite FK would forbid the feature:')
  for (const f of crossOrg) console.log(`  – ${f.child_table}.${f.child_cols[0]} → ${f.parent_table}`)
  console.log('')
}

await pool.end()

// Ratchet: a genuine gap fails the build. The by-design list never does.
if (risky.length) {
  console.error(`tenant-fk-audit: ${risky.length} unprotected cross-tenant reference(s). ` +
    'Add a composite FK (see migration 071 for the pattern) or, if the child is ' +
    'deliberately not org-scoped, say so in that migration\'s header.')
  process.exit(1)
}
