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
export async function sendEmail({ to, subject, html, text, attachments }) {
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
  // Logs the message in a way that's easy to spot in a noisy console.
  console.log('\n┌─ [email:stub] ─────────────────────────────────────────────')
  console.log(`│ FROM:    ${from}`)
  console.log(`│ TO:      ${Array.isArray(to) ? to.join(', ') : to}`)
  console.log(`│ SUBJECT: ${subject}`)
  console.log('│')
  if (text) {
    console.log('│ TEXT:')
    text.split('\n').forEach(line => console.log(`│   ${line}`))
  }
  if (Array.isArray(attachments) && attachments.length) {
    console.log('│ ATTACHMENTS:')
    attachments.forEach(a => console.log(`│   ${a.filename} (${Math.round((a.content?.length ?? 0) * 3 / 4 / 1024)} KB)`))
  }
  if (html && !text) {
    console.log('│ HTML (no text fallback provided):')
    console.log(`│   ${html.slice(0, 200)}${html.length > 200 ? '…' : ''}`)
  }
  console.log('└────────────────────────────────────────────────────────────\n')

  return { ok: true, id: `stub-${Date.now()}` }
}
