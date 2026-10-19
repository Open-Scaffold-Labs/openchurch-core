#!/usr/bin/env node
// Take a copy now, with no vendor decision at all.
//
// The weekly digest needs somewhere to deliver. Until the team lead picks
// object storage, there is no scheduled off-site copy — and "we will have
// backups once a decision is made" is not a sentence to say while a real
// parish is typing into the thing.
//
// This is the manual version of the same run: every parish's export,
// gzipped, written to a directory you choose. Put that directory
// somewhere that syncs, or copy it to an external disk. It is not a
// substitute for the schedule and does not pretend to be — it is a copy
// that exists today rather than a copy that exists after a meeting.
//
//   OCHR_REHEARSAL=local node --env-file=server/.env scripts/pull-backup.mjs --to ~/openchurch-backups
//
// DELIBERATELY A SCRIPT, NOT AN ENDPOINT. The obvious alternative was a
// founder-only route that streams every parish's data. That is a
// permanent cross-tenant export surface, reachable from the internet,
// guarded by one env-var email check — added to solve a problem that
// lasts until a storage bucket exists. A script run from a laptop with
// the database URL already in hand adds no surface at all.
//
// FAIL-CLOSED FOR REMOTE (RECOVERY-L3-05). Loopback targets run freely.
// A non-loopback DATABASE_URL requires OCHR_BACKUP_PULL=remote-acknowledged
// so a stale shell cannot silently dump every parish from production.
// Log lines strip the userinfo password and query password / sslpassword.
// A directory of files is a copy, not a verified restore.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { classifyDatabaseUrl, redactDatabaseUrl } from './lib/db-target-guard.mjs'

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : null
}
const dest = arg('to')
if (!dest) {
  console.error('Where should the copy go?\n\n  node scripts/pull-backup.mjs --to <directory>\n')
  process.exit(2)
}

const cls = classifyDatabaseUrl(process.env.DATABASE_URL)
console.log(`pull-backup: target ${redactDatabaseUrl(process.env.DATABASE_URL)} (${cls.kind})`)
if (cls.kind !== 'local') {
  if (process.env.OCHR_BACKUP_PULL !== 'remote-acknowledged') {
    console.error('DATABASE_URL is not loopback. A copy of every parish would leave this host.')
    console.error('Set OCHR_BACKUP_PULL=remote-acknowledged to proceed, or use local-db.')
    console.error('Refusing.')
    process.exit(2)
  }
  console.log('pull-backup: remote target acknowledged via OCHR_BACKUP_PULL=remote-acknowledged')
}
console.log('This is a copy, not a verified restore, and not PITR / production DR.\n')

const { default: pool } = await import('../server/src/db.js')
const { buildOrgExport } = await import('../server/src/services/orgExport.js')

const stamp = new Date().toISOString().slice(0, 10)
const dir = join(dest.replace(/^~/, process.env.HOME || '~'), stamp)

let ok = 0, failed = 0, bytes = 0
try {
  await mkdir(dir, { recursive: true })
  const { rows: orgs } = await pool.query(
    'SELECT id, name, slug FROM ochr_organizations ORDER BY id')
  console.log(`${orgs.length} parishes → ${dir}\n`)

  for (const org of orgs) {
    try {
      const dump = await buildOrgExport(org.id)
      const gz = gzipSync(Buffer.from(JSON.stringify(dump), 'utf8'))
      const rows = Object.values(dump.counts ?? {}).reduce((a, b) => a + b, 0)
      const file = `${org.slug || org.id}-${stamp}.json.gz`
      await writeFile(join(dir, file), gz)
      ok++; bytes += gz.length
      console.log(`  ✓ ${org.name} — ${rows.toLocaleString()} rows, ${(gz.length / 1024).toFixed(0)} KB`)
    } catch (err) {
      failed++
      console.log(`  ✗ ${org.name} — ${String(err?.message ?? err).slice(0, 100)}`)
    }
  }

  // A count of files written is not proof they can be read back. The
  // off-site drill exists for that, and this says so rather than letting
  // a directory listing stand in for a restore.
  console.log(`\n${ok} written, ${failed} failed, ${(bytes / 1048576).toFixed(2)} MiB total`)
  console.log(`\nThis is a copy, not a verified restore. To prove one of these files`)
  console.log(`can actually be put back:`)
  console.log(`  RESTORE_URL=<an empty local db> OCHR_REHEARSAL=local node scripts/offsite-restore-drill.mjs`)
  if (failed) process.exitCode = 1
} catch (err) {
  console.error('failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
