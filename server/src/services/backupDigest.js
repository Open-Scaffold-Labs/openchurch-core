// Weekly off-site backup digest — the founder's copy of every parish's
// canonical data, delivered by email every Saturday. Sacramental records
// are permanent and canonically unfixable if lost; everything in this
// file exists because of that sentence.
//
// This is the LOGICAL layer of a two-layer backup story:
//   Layer 1 (infra): Supabase PITR / daily snapshots — dashboard config,
//     configured in the Supabase dashboard.
//   Layer 2 (this): per-parish JSON exports, gzipped, mailed off-site to
//     SUPER_ADMIN_EMAIL — survives account-level loss of Layer 1, and
//     doubles as a delivery heartbeat: no Saturday email = cron is broken.
//
// Explicitly configured or explicitly skipped: without SUPER_ADMIN_EMAIL
// (or a live email transport) the run reports itself as skipped rather
// than silently "succeeding".

import { gzipSync } from 'node:zlib'
import pool from '../db.js'
import { buildOrgExport } from './orgExport.js'
import { sendEmail } from '../email/send.js'
import { monitor } from '../monitoring/index.js'

// Resend caps total message size (~40MB); stay far under it per file.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

export async function runWeeklyBackupDigest({ now = new Date() } = {}) {
  const recipient = process.env.SUPER_ADMIN_EMAIL
  if (!recipient) return { skipped: 'SUPER_ADMIN_EMAIL not configured' }

  const stamp = now.toISOString().slice(0, 10)
  const { rows: orgs } = await pool.query(
    'SELECT id, name, slug FROM ochr_organizations ORDER BY id'
  )

  const attachments = []
  const lines = []
  let attached = 0
  let oversized = 0
  let failed = 0

  for (const org of orgs) {
    try {
      const dump = await buildOrgExport(org.id)
      const gz = gzipSync(Buffer.from(JSON.stringify(dump), 'utf8'))
      const totalRows = Object.values(dump.counts).reduce((a, b) => a + b, 0)

      if (gz.length <= MAX_ATTACHMENT_BYTES) {
        attachments.push({
          filename: `${org.slug || org.id}-${stamp}.json.gz`,
          content:  gz.toString('base64'),
        })
        attached++
        lines.push(`• ${org.name}: ${totalRows} rows, ${(gz.length / 1024).toFixed(0)} KB — attached`)
      } else {
        oversized++
        lines.push(`• ${org.name}: ${totalRows} rows — TOO LARGE for email (${(gz.length / 1048576).toFixed(1)} MB); pull via /api/organization/export`)
      }
    } catch (err) {
      failed++
      lines.push(`• ${org.name}: EXPORT FAILED — ${String(err?.message ?? err).slice(0, 120)}`)
      monitor.error('backup.digest.org', err, { orgId: org.id })
    }
  }

  const subject = failed
    ? `⚠ OpenChurch weekly backup — ${failed} FAILED, ${attached}/${orgs.length} attached`
    : `OpenChurch weekly backup — ${attached}/${orgs.length} parishes (${stamp})`

  await sendEmail({
    to: recipient,
    subject,
    text:
`Weekly parish data backup, ${stamp}.

${lines.join('\n')}

Store this email's attachments somewhere durable. If this email ever
stops arriving on Saturdays, the backup cron is broken — treat that as
an incident, not an inconvenience.
`,
    attachments,
  })

  return { orgs: orgs.length, attached, oversized, failed }
}
