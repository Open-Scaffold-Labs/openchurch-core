// Weekly off-site backup digest — the founder's copy of every parish's
// canonical data, delivered by email every Saturday. Sacramental records
// are permanent and canonically unfixable if lost; everything in this
// file exists because of that sentence.
//
// This is the LOGICAL layer of a two-layer backup story:
//   Layer 1 (infra): Supabase PITR / daily snapshots — dashboard config,
//     configured in the Supabase dashboard.
//   Layer 2 (this): per-parish JSON exports, gzipped, written to object
//     storage — survives account-level loss of Layer 1.
//
// STORAGE IS THE VAULT; EMAIL IS THE HEARTBEAT. It used to be the other
// way round, and the artifact was an email attachment or nothing. Two
// things were wrong with that. The small one: an 8 MB attachment cap
// silently downgraded a large parish to a line of text saying "pull it
// yourself". The large one: with no email transport configured — which
// was the case in production — the export was built, handed to a console
// stub, and discarded, weekly, while the run reported success.
//
// So the copy goes to storage, which is the thing that has to survive,
// and the email becomes the notification that it happened. Either can be
// configured without the other; the run refuses only when there is
// genuinely nowhere for the artifact to go.
//
// Explicitly configured or explicitly skipped: with nowhere to put the
// artifact and no way to say so, the run reports itself skipped rather
// than silently "succeeding". That guard is the whole reason this file
// was rewritten — it used to return its success shape regardless.

import { gzipSync } from 'node:zlib'
import pool from '../db.js'
import { buildOrgExport } from './orgExport.js'
import { sendEmail, emailTransportIsLive } from '../email/send.js'
import { putObject, verifyObject, describeStorage } from '../storage/index.js'
import { monitor } from '../monitoring/index.js'

// Resend caps total message size (~40MB); stay far under it per file.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

export async function runWeeklyBackupDigest({ now = new Date() } = {}) {
  const store = describeStorage()
  const recipient = process.env.SUPER_ADMIN_EMAIL
  const canMail = Boolean(recipient) && emailTransportIsLive()

  // Refuse only when there is nowhere for the artifact to go AND no way
  // to say so. Storage alone is a working backup with no notification;
  // email alone is the old behaviour, still useful for a small parish.
  // Neither is the case this exists to catch: building an export of every
  // parish and discarding it while returning success.
  if (!store.live && !canMail) {
    return {
      skipped: 'nowhere to deliver — no backup storage and no live email transport',
      storage: store.detail,
      email: recipient ? 'transport not live' : 'SUPER_ADMIN_EMAIL not configured',
    }
  }


  const stamp = now.toISOString().slice(0, 10)
  const { rows: orgs } = await pool.query(
    'SELECT id, name, slug FROM ochr_organizations ORDER BY id'
  )

  const attachments = []
  const lines = []
  let attached = 0
  let oversized = 0
  let failed = 0
  let stored = 0
  const storeFailures = []

  for (const org of orgs) {
    try {
      const dump = await buildOrgExport(org.id)
      const gz = gzipSync(Buffer.from(JSON.stringify(dump), 'utf8'))
      const totalRows = Object.values(dump.counts).reduce((a, b) => a + b, 0)

      const name = `${org.slug || org.id}-${stamp}.json.gz`
      const size = `${(gz.length / 1024).toFixed(0)} KB`
      let note = ''

      // The copy that matters. Written first, and VERIFIED — a PUT that
      // returns 200 and leaves nothing behind is the exact failure this
      // whole change exists to stop, so the digest reads the object back
      // rather than trusting the write.
      if (store.live) {
        const key = `${stamp}/${name}`
        try {
          await putObject({ key, body: gz, contentType: 'application/gzip' })
          const check = await verifyObject(key, gz.length)
          if (check.ok) { stored++; note = ` — stored as ${key}` }
          else { storeFailures.push(`${org.name}: ${check.why}`); note = ` — STORE UNVERIFIED (${check.why})` }
        } catch (err) {
          storeFailures.push(`${org.name}: ${String(err?.message ?? err).slice(0, 120)}`)
          note = ` — STORE FAILED`
          monitor.error('backup.digest.store', err, { orgId: org.id, key })
        }
      }

      // The attachment is now a convenience, not the backup. Skipping an
      // oversized one is no longer a downgrade when storage holds it.
      if (canMail && gz.length <= MAX_ATTACHMENT_BYTES) {
        attachments.push({ filename: name, content: gz.toString('base64') })
        attached++
        note += ' — attached'
      } else if (canMail) {
        oversized++
        note += ` — too large to attach (${(gz.length / 1048576).toFixed(1)} MB)`
      }

      lines.push(`• ${org.name}: ${totalRows} rows, ${size}${note}`)
    } catch (err) {
      failed++
      lines.push(`• ${org.name}: EXPORT FAILED — ${String(err?.message ?? err).slice(0, 120)}`)
      monitor.error('backup.digest.org', err, { orgId: org.id })
    }
  }

  const trouble = failed + storeFailures.length
  const subject = trouble
    ? `⚠ OpenChurch weekly backup — ${trouble} problem(s), ${stored}/${orgs.length} stored`
    : `OpenChurch weekly backup — ${stored}/${orgs.length} parishes stored (${stamp})`

  if (canMail) {
    await sendEmail({
      to: recipient,
      subject,
      text:
`Weekly parish data backup, ${stamp}.

Storage: ${store.live ? store.detail : 'NOT CONFIGURED — the attachments below are the only copy'}

${lines.join('\n')}
${storeFailures.length ? `\nSTORE PROBLEMS:\n${storeFailures.map(f => `• ${f}`).join('\n')}\n` : ''}
${store.live
  ? `The durable copy is in storage; the attachments are a convenience. If
this email stops arriving on Saturdays the cron is broken — but check
storage before assuming the backup is gone.`
  : `There is no backup storage configured, so these attachments are the
only copy. Store them somewhere durable, and configure BACKUP_S3_* so
this stops depending on a mailbox.`}
`,
      attachments,
    })
  }

  return {
    orgs: orgs.length,
    stored, attached, oversized, failed,
    storage: store.live ? store.detail : null,
    notified: canMail,
    store_failures: storeFailures,
  }
}
