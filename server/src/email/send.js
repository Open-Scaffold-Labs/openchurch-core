// Vendor-neutral email send. The rest of the server calls sendEmail()
// without knowing or caring what's behind it.
//
// Transport selection is env-driven, checked AT CALL TIME so tests can
// toggle it and a redeploy isn't needed to flip modes:
//
//   RESEND_API_KEY set   → live delivery via Resend's REST API.
//   RESEND_API_KEY unset → the console stub (dev default). No key, no
//                          network, no accidental sends from dev boxes.
//
// EMAIL_FROM is the default sender ("Name <addr@domain>"). The domain
// must be verified in the Resend dashboard before live sends succeed.

// Sends a single transactional email.
//
// Shape:
//   sendEmail({ to, subject, html, text })
//   - to:      string | string[]     — recipient address(es)
//   - subject: string                 — subject line
//   - html:    string                 — HTML body
//   - text:    string                 — plain-text fallback (always include
//                                       one for clients that don't render HTML
//                                       and for accessibility)
//
// Returns { ok, id? } on success or throws on transport failure —
// callers that fire-and-forget must wrap in try/catch.
// Optional `attachments`: [{ filename, content }] where content is a
// base64 string — passed through to Resend verbatim; the stub logs
// names and sizes only.
// Optional `headers`: { 'Header-Name': 'value' } — extra RFC 5322 headers
// passed through verbatim. This is how List-Unsubscribe reaches the
// message; it has to be a real header, not body text, because that is
// the only place a mail client looks for it.
// Is there a real transport behind sendEmail, or only the console stub?
//
// Exported because a caller sometimes needs to know BEFORE it does the
// work. The weekly backup digest is the case that forced this: it built
// a gzipped export of every parish, attached it to an email, watched the
// stub print it to a log, and returned success. The artifact was
// produced and discarded, weekly, and the run reported that it had
// worked. A backup that reports success while delivering nothing is
// worse than one that fails loudly, because it stops anybody looking.
import { maskRecipients, scrubText } from '../utils/redact.js'

export function emailTransportIsLive() {
  return Boolean(process.env.RESEND_API_KEY)
}

export async function sendEmail({ to, subject, html, text, attachments, headers }) {
  if (!to)      throw new Error('sendEmail: missing `to`')
  if (!subject) throw new Error('sendEmail: missing `subject`')
  if (!html && !text) throw new Error('sendEmail: missing both `html` and `text`')

  const apiKey = process.env.RESEND_API_KEY
  const from   = process.env.EMAIL_FROM || 'OpenChurch <hello@example.com>'

  // ── Live transport: Resend ──────────────────────────────────────
  // Plain REST via global fetch (Node 22) — no SDK dependency. Body
  // shape per https://resend.com/docs/api-reference/emails/send-email
  if (apiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        ...(html ? { html } : {}),
        ...(text ? { text } : {}),
        ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
      }),
    })

    if (!res.ok) {
      // Read the error body for the log, but never let a parse failure
      // mask the real problem.
      let detail = ''
      try { detail = (await res.text()).slice(0, 300) } catch { /* ignore */ }
      throw new Error(`Resend send failed (${res.status}): ${detail}`)
    }

    const data = await res.json().catch(() => ({}))
    return { ok: true, id: data.id ?? null }
  }

  // ── Stub transport (no key configured) ──────────────────────────
  // ARG-LEAK-2: the stub used to print the whole message (body, reset and
  // invite links, headers) to stdout. In production that is a token leak
  // into platform logs, and the mail is not delivered anyway, so refuse
  // loudly there. Elsewhere log a masked envelope only: no body, no
  // headers, no URLs or tokens.
  if (process.env.NODE_ENV === 'production') {
    console.error('[email] RESEND_API_KEY is not set in production; refusing to stub-send (message withheld)')
    const e = new Error('Email transport not configured (RESEND_API_KEY unset in production)')
    e.code = 'EMAIL_TRANSPORT_UNCONFIGURED'
    throw e
  }
  const nAtt = Array.isArray(attachments) ? attachments.length : 0
  console.log(`[email:stub] to=${maskRecipients(to)} subject="${scrubText(subject)}" ` +
    `text=${text ? text.length : 0}c html=${html ? html.length : 0}c attachments=${nAtt} (body not logged)`)

  return { ok: true, id: `stub-${Date.now()}` }
}
