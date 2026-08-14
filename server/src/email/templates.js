// Email content lives here, separate from the send transport. Templates
// return { subject, html, text } so callers just spread the result into
// sendEmail({ to, ...template(...) }).
//
// Style note: keep HTML simple. Inline styles only — most email clients
// strip <style> tags and class hooks. Body width caps at 560px so it
// renders well in narrow preview panes. Buttons are <a> tags styled as
// blocks because <button> doesn't work in email.

const APP_NAME = 'OpenChurch'

function wrap({ heading, body, ctaLabel, ctaUrl, footer }) {
  const cta = ctaLabel && ctaUrl
    ? `<p style="margin:28px 0;text-align:center;">
         <a href="${ctaUrl}" style="display:inline-block;padding:12px 22px;background:#7B2D26;color:#FAF6EE;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
           ${ctaLabel}
         </a>
       </p>`
    : ''
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#FAF6EE;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2A1F1A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF6EE;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFDF7;border:1px solid rgba(123,45,38,0.12);border-radius:14px;padding:36px 32px;">
        <tr><td>
          <p style="margin:0 0 24px;font-family:Georgia,'Cormorant Garamond',serif;font-size:22px;font-weight:600;color:#7B2D26;letter-spacing:0.5px;">${APP_NAME}</p>
          <h1 style="margin:0 0 16px;font-family:Georgia,'Cormorant Garamond',serif;font-size:24px;font-weight:600;line-height:1.25;">${heading}</h1>
          <div style="font-size:15px;line-height:1.6;color:#3D2E26;">${body}</div>
          ${cta}
          <hr style="border:none;border-top:1px solid rgba(123,45,38,0.10);margin:32px 0 18px;" />
          <p style="margin:0;font-size:12px;line-height:1.5;color:#7A6A5F;">${footer || ''}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

// Welcome email — sent on signup. Personal but quiet; sets expectations.
export function welcomeEmail({ name, organizationName, dashboardUrl }) {
  const first = (name || '').trim().split(/\s+/)[0] || 'there'
  const subject = `Welcome to ${APP_NAME}, ${first}`
  const text = [
    `Welcome to ${APP_NAME}, ${first}.`,
    '',
    `Your workspace for ${organizationName} is ready. We've added a few sample`,
    `members, events, and tasks so the pages aren't empty on first login —`,
    `clear them whenever you're ready to start fresh.`,
    '',
    `Open your dashboard: ${dashboardUrl}`,
    '',
    `If you didn't sign up for ${APP_NAME}, you can ignore this email.`,
  ].join('\n')
  const html = wrap({
    heading: `Welcome, ${first}.`,
    body: `
      <p>Your workspace for <strong>${organizationName}</strong> is ready.</p>
      <p>We added a few sample members, events, and tasks so the pages aren't empty on first login. Clear them from the Dashboard banner whenever you're ready to start fresh.</p>
    `,
    ctaLabel: 'Open your dashboard',
    ctaUrl:   dashboardUrl,
    footer:   `If you didn't sign up for ${APP_NAME}, you can safely ignore this email.`,
  })
  return { subject, html, text }
}

// Password-reset email. The link contains the raw token; the server
// looks up the SHA-256 hash on /api/auth/reset-password.
export function passwordResetEmail({ name, resetUrl }) {
  const first = (name || '').trim().split(/\s+/)[0] || 'there'
  const subject = `Reset your ${APP_NAME} password`
  const text = [
    `Hi ${first},`,
    '',
    `We received a request to reset the password on your ${APP_NAME} account.`,
    `Open this link to set a new one (valid for one hour):`,
    '',
    resetUrl,
    '',
    `If you didn't ask for this, you can ignore the email — your password`,
    `won't change.`,
  ].join('\n')
  const html = wrap({
    heading: 'Reset your password',
    body: `
      <p>Hi ${first},</p>
      <p>We received a request to reset the password on your ${APP_NAME} account. The link below is valid for one hour.</p>
    `,
    ctaLabel: 'Choose a new password',
    ctaUrl:   resetUrl,
    footer:   `If you didn't ask for a reset, you can safely ignore this email — your password won't change.`,
  })
  return { subject, html, text }
}
