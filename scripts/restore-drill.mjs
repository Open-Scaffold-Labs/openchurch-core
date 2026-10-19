#!/usr/bin/env node
// The restore drill (Continuity Vault / layer 3).
//
// A backup nobody has restored is a rumour. This script proves, against
// a disposable LOCAL Postgres, that the Continuity Vault can put a
// record back — the row, the rows Postgres cascaded away with it, and
// the reference it set to NULL on a row that survived.
//
// It builds its own throwaway organisation, does the whole round trip,
// checks the result, and removes everything it made.
//
// FAIL-CLOSED (RECOVERY-L3-05). Requires OCHR_REHEARSAL=local and a
// loopback DATABASE_URL (including libpq ?host= / ?hostaddr=). The gate
// runs BEFORE any database driver import so a refuse path cannot depend
// on server deps. It never follows server/.env as a safety mechanism —
// export DATABASE_URL from `node scripts/local-db.mjs env` first. Local
// restore success is not PITR, not hosted backup, and not production
// rollback.
//
//   OCHR_REHEARSAL=local DATABASE_URL="$(node scripts/local-db.mjs env | cut -d= -f2- | tr -d \')" \
//     node scripts/restore-drill.mjs
//
// Exit 0 = recovery works here today. Exit 1 = it does not, and the
// promise on the Archive & Recovery page is not currently true.
// Exit 2 = refused (wrong identity or non-loopback target).

import { redactDatabaseUrl, requireLocalRehearsal } from './lib/db-target-guard.mjs'

const gate = requireLocalRehearsal({
  rehearsal: process.env.OCHR_REHEARSAL,
  urls: [{ label: 'DATABASE_URL', url: process.env.DATABASE_URL }],
})
if (!gate.ok) {
  console.error(`restore-drill: ${gate.reason}`)
  process.exit(gate.code)
}
console.log(`restore-drill: ${gate.reason}`)
console.log(`              target ${redactDatabaseUrl(process.env.DATABASE_URL)}`)
console.log('              LOCAL ONLY — not PITR, not hosted backup, not production.\n')

const { default: pool } = await import('../server/src/db.js')
const { captureAndDelete, restoreEntry } = await import('../server/src/vault/index.js')

const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
const checks = []
const check = (name, ok) => { checks.push({ name, ok }); return ok }

let orgId = null
try {
  const { rows: [org] } = await pool.query(
    `INSERT INTO ochr_organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Restore Drill ${stamp}`, `restore-drill-${stamp}`]
  )
  orgId = org.id
  const { rows: [user] } = await pool.query(
    `INSERT INTO ochr_users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'Drill Operator', $2, 'x-not-a-login', 'admin') RETURNING id, name, email`,
    [orgId, `restore-drill-${stamp}@invalid.local`]
  )

  const { rows: [member] } = await pool.query(
    `INSERT INTO ochr_clients (organization_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
    [orgId, `Drill Member ${stamp}`]
  )
  const { rows: [group] } = await pool.query(
    `INSERT INTO ochr_groups (organization_id, name, leader_client_id) VALUES ($1, $2, $3) RETURNING id`,
    [orgId, `Drill Group ${stamp}`, member.id]
  )
  await pool.query(
    `INSERT INTO ochr_group_members (organization_id, group_id, client_id) VALUES ($1, $2, $3)`,
    [orgId, group.id, member.id]
  )

  const captured = await captureAndDelete({
    kind: 'member', id: member.id, orgId, user, reason: 'restore drill',
  })
  check('the delete was captured', Boolean(captured?.entry_id))
  check('the member is gone from the parish records',
    (await pool.query('SELECT 1 FROM ochr_clients WHERE id = $1', [member.id])).rowCount === 0)
  check('her place on the roster went with her',
    (await pool.query('SELECT 1 FROM ochr_group_members WHERE client_id = $1', [member.id])).rowCount === 0)
  check('the group she led lost its leader',
    (await pool.query('SELECT leader_client_id FROM ochr_groups WHERE id = $1', [group.id])).rows[0].leader_client_id === null)

  const restored = await restoreEntry({ entryId: captured.entry_id, orgId, user })
  check('the member is back',
    (await pool.query('SELECT 1 FROM ochr_clients WHERE id = $1', [member.id])).rowCount === 1)
  check('the roster row came back with her',
    (await pool.query('SELECT 1 FROM ochr_group_members WHERE client_id = $1 AND group_id = $2',
      [member.id, group.id])).rowCount === 1)
  check('the group has its leader again',
    (await pool.query('SELECT leader_client_id FROM ochr_groups WHERE id = $1', [group.id])).rows[0].leader_client_id === member.id)
  check('the entry records who restored it and when',
    Boolean(restored?.entry_id) &&
    (await pool.query('SELECT restored_at FROM ochr_vault_entries WHERE id = $1',
      [captured.entry_id])).rows[0].restored_at !== null)
} catch (err) {
  check(`the drill ran without error — ${err.message}`, false)
} finally {
  if (orgId) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await pool.end()
}

const failed = checks.filter(c => !c.ok)
for (const c of checks) console.log(`${c.ok ? '  ✓' : '  ✗'} ${c.name}`)
console.log(`\nrestore drill: ${checks.length - failed.length}/${checks.length} — ` +
  (failed.length ? 'RECOVERY IS NOT WORKING IN THIS DATABASE' : 'recovery works in this database'))
process.exit(failed.length ? 1 : 0)
