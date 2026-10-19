// Weekly off-site backup — each parish's canonical data written to backup
// storage every Saturday; the email is a zero-PII heartbeat. Sacramental
// records are permanent and canonically unfixable if lost; everything in
// this file exists because of that sentence.
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
// and the email becomes the notification that it happened.
//
// STORAGE-FIRST, ZERO-PII NOTIFICATION (#214). The email used to attach
// every parish's full export and send it through the email provider to
// one inbox whenever RESEND_API_KEY and SUPER_ADMIN_EMAIL were both set,
// with or without storage. Production has SUPER_ADMIN_EMAIL set, so one
// env var (the same key password-reset mail needs) would have started
// mailing every tenant's data weekly. Now:
//   - no export is ever attached to, or quoted in, an email;
//   - with no storage the run builds NO export at all: it is skipped, and
//     the heartbeat (if mail is live) says the backup is NOT running;
//   - the heartbeat carries counts, the date and numeric org ids for
//     problems only: no parish names, slugs, rows or export content;
//   - objects are tenant-separated: orgs/<orgId>/<date>.json.gz.
//
// Explicitly configured or explicitly skipped: with nowhere durable to put
// the artifact the run reports itself skipped rather than silently
// "succeeding".

import { gzipSync } from 'node:zlib'
import pool from '../db.js'
import { buildOrgExport } from './orgExport.js'
import { sendEmail, emailTransportIsLive } from '../email/send.js'
import { putObject, verifyObject, describeStorage } from '../storage/index.js'
import { monitor } from '../monitoring/index.js'

// One prefix per tenant, keyed by the immutable org id — never the slug or
// name, which are parish-chosen and would put a tenant's identity into
// every listing. Restore finds a parish's copies with listObjects(orgPrefix).
export function backupOrgPrefix(orgId) {
  return `orgs/${Number(orgId)}/`
}
export function backupKeyFor(orgId, stamp) {
  return `${backupOrgPrefix(orgId)}${stamp}.json.gz`
}

// The ONLY text a backup email may carry. Counts, the date, the storage
// driver kind, and numeric org ids for problems. Built from numbers so a
// parish name cannot reach it by accident.
export function composeBackupHeartbeat({ stamp, orgs, stored, failedIds, storeFailedIds, storageLive, storageKind }) {
  const n = x => Number(x) || 0
  if (!storageLive) {
    return {
      subject: `⚠ OpenChurch weekly backup NOT RUNNING (${stamp})`,
      text:
`Weekly parish backup, ${stamp}: NOT RUN.

No backup storage is configured, so no export was built and nothing was
backed up. Backups are never sent by email.

Configure BACKUP_STORAGE (see server/src/storage/index.js) to resume.
`,
    }
  }
  const problems = [...failedIds, ...storeFailedIds].map(n)
  const subject = problems.length
    ? `⚠ OpenChurch weekly backup — ${problems.length} problem(s), ${n(stored)}/${n(orgs)} stored (${stamp})`
    : `OpenChurch weekly backup — ${n(stored)}/${n(orgs)} stored (${stamp})`
  return {
    subject,
    text:
`Weekly parish backup, ${stamp}.

Stored: ${n(stored)} of ${n(orgs)} organizations (${storageKind} storage).
${problems.length ? `Problems (organization ids): ${problems.join(', ')}\nDetails are in the monitor log.\n` : 'No problems.\n'}
This message contains no parish data. Backups are never attached to email;
they are in storage.
`,
  }
}

// A failed send is a failed notification. It is never recorded as sent.
// When storage already succeeded, the caller still receives those counts.
async function deliverHeartbeat(recipient, hb) {
  try {
    await sendEmail({ to: recipient, subject: hb.subject, text: hb.text })
    return { notified: true, email: 'heartbeat sent' }
  } catch (err) {
    monitor.error('backup.digest.notify', err)
    return {
      notified: false,
      email: 'heartbeat send failed',
      notify_error: String(err?.message ?? err).slice(0, 200),
    }
  }
}

export async function runWeeklyBackupDigest({ now = new Date() } = {}) {
  const store = describeStorage()
  const recipient = process.env.SUPER_ADMIN_EMAIL
  const canMail = Boolean(recipient) && emailTransportIsLive()
  const stamp = now.toISOString().slice(0, 10)

  // Storage is the only destination for parish data. Without it, build
  // nothing: an export that exists only in memory (or, before #214, in an
  // email attachment) is not a backup.
  if (!store.live) {
    const mail = canMail
      ? await deliverHeartbeat(recipient, composeBackupHeartbeat({
          stamp, storageLive: false, orgs: 0, stored: 0, failedIds: [], storeFailedIds: [],
        }))
      : { notified: false, email: recipient ? 'transport not live' : 'SUPER_ADMIN_EMAIL not configured' }
    return {
      skipped: 'no backup storage configured — no export built (backups are never emailed)',
      storage: store.detail,
      email: mail.email,
      notified: mail.notified,
      ...(mail.notify_error ? { notify_error: mail.notify_error } : {}),
    }
  }

  const { rows: orgs } = await pool.query(
    'SELECT id FROM ochr_organizations WHERE held_at IS NULL ORDER BY id'
  )

  let stored = 0
  let failed = 0
  const failedIds = []
  const storeFailures = []
  const storeFailedIds = []

  for (const org of orgs) {
    try {
      const dump = await buildOrgExport(org.id)
      const gz = gzipSync(Buffer.from(JSON.stringify(dump), 'utf8'))
      // The copy that matters. Written, then VERIFIED — a PUT that returns
      // 200 and leaves nothing behind is exactly what this must catch.
      const key = backupKeyFor(org.id, stamp)
      try {
        const { rows: activeOrg } = await pool.query(
          'SELECT id FROM ochr_organizations WHERE id = $1 AND held_at IS NULL', [org.id],
        )
        if (!activeOrg.length) continue
        await putObject({ key, body: gz, contentType: 'application/gzip' })
        const check = await verifyObject(key, gz.length)
        if (check.ok) stored++
        else {
          storeFailures.push(`org ${org.id}: ${check.why}`)
          storeFailedIds.push(org.id)
          // The heartbeat says problem details are in the monitor log.
          // That sentence is true only if this branch writes one.
          monitor.error('backup.digest.verify', new Error(check.why), { orgId: org.id, key })
        }
      } catch (err) {
        storeFailures.push(`org ${org.id}: ${String(err?.message ?? err).slice(0, 120)}`)
        storeFailedIds.push(org.id)
        monitor.error('backup.digest.store', err, { orgId: org.id, key })
      }
    } catch (err) {
      failed++
      failedIds.push(org.id)
      monitor.error('backup.digest.org', err, { orgId: org.id })
    }
  }

  // After every object is written and verified. No `attachments`, ever.
  const mail = canMail
    ? await deliverHeartbeat(recipient, composeBackupHeartbeat({
        stamp, orgs: orgs.length, stored, failedIds, storeFailedIds,
        storageLive: true, storageKind: store.driver,
      }))
    : { notified: false }

  return {
    orgs: orgs.length,
    stored, failed,
    attached: 0,
    storage: store.detail,
    notified: mail.notified,
    store_failures: storeFailures,
    ...(mail.notify_error ? { notify_error: mail.notify_error } : {}),
  }
}
