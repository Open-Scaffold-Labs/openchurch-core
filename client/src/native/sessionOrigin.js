// Whether the WebView can carry the parish session cookie.
//
// The cookie (server/src/auth/sessionCookie.js) is httpOnly,
// SameSite=Lax, Path=/, and Secure on a production-like server. The
// parish page and /api share one origin, so the browser sends it on
// same-origin fetch with credentials: 'include'. A cross-site fetch
// does not. This module does not set, read, or replace that cookie.

function parsed(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isHttpFamily(url) {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

// Capacitor's bundled page is capacitor://localhost (or the older
// ionic://localhost). https://localhost with no port is the same local
// shell when the iOS scheme is https. Vite on :5202 is a different origin.
export function isBundledShellOrigin(value) {
  const url = typeof value === 'string' ? parsed(value) : value
  if (!url) return false
  if (url.protocol === 'capacitor:' || url.protocol === 'ionic:') return true
  if (!isHttpFamily(url)) return false
  if (url.hostname !== 'localhost') return false
  return url.port === ''
}

export function sessionCookieCanRide({ documentUrl, apiBase } = {}) {
  const doc = parsed(documentUrl)
  if (!doc) return { ok: false, reason: 'unreadable-document' }
  // capacitor:// and ionic:// report origin "null". They are the bundled
  // shell, not an unreadable address.
  if (doc.protocol === 'capacitor:' || doc.protocol === 'ionic:') {
    return { ok: false, reason: 'bundled-shell' }
  }
  if (!isHttpFamily(doc) || !doc.origin || doc.origin === 'null') {
    return { ok: false, reason: 'unreadable-document' }
  }

  const api = typeof apiBase === 'string' ? apiBase.trim() : ''
  if (!api) {
    if (isBundledShellOrigin(doc)) return { ok: false, reason: 'bundled-shell' }
    if (!isHttpFamily(doc)) return { ok: false, reason: 'bundled-shell' }
    return { ok: true, reason: 'same-origin-relative' }
  }

  const apiUrl = parsed(api)
  if (!apiUrl || !isHttpFamily(apiUrl)) return { ok: false, reason: 'unreadable-api' }
  if (apiUrl.origin !== doc.origin) return { ok: false, reason: 'cross-origin' }
  return { ok: true, reason: 'same-origin-absolute' }
}
