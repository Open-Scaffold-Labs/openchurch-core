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
//   node --env-file=server/.env scripts/pull-backup.mjs --to ~/openchurch-backups
//
// DELIBERATELY A SCRIPT, NOT AN ENDPOINT. The obvious alternative was a
// founder-only route that streams every parish's data. That is a
// permanent cross-tenant export surface, reachable from the internet,
// guarded by one env-var email check — added to solve a problem that
// lasts until a storage bucket exists. A script run from a laptop with
// the database URL already in hand adds no surface at all.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import pool from '../server/src/db.js'
import { buildOrgExport } from '../server/src/services/orgExport.js'

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : null
}
const dest = arg('to')
if (!dest) {
  console.error('Where should the copy go?\n\n  node --env-file=server/.env scripts/pull-backup.mjs --to <directory>\n')
  process.exit(2)
}

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
  console.log(`  RESTORE_URL=<an empty local db> node --env-file=server/.env scripts/offsite-restore-drill.mjs`)
  if (failed) process.exitCode = 1
} catch (err) {
  console.error('failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
