// Where a link or a checkout address should open inside the iOS shell.
// Same-origin parish pages stay in the WebView. Another site opens in
// the system Safari view. Mail and phone links go to the system handler.
// Script and credentialed addresses are refused.

const MAIL_PROTOCOLS = new Set(['mailto:', 'tel:', 'sms:'])

export function classifyAwayNavigation(href, pageHref) {
  // Fail closed: anything that is not a same-origin page, an http(s)
  // page elsewhere, or a mail/phone link is blocked, never ignored, so
  // default navigation cannot run an obfuscated script scheme.
  if (typeof href !== 'string') return { action: 'block' }
  // The URL parser drops ASCII tab/newline anywhere and C0 controls or
  // spaces at the ends; mirror that before checking the scheme.
  // eslint-disable-next-line no-control-regex
  const raw = href.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
  if (!raw || raw.startsWith('#')) return { action: 'stay' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { action: 'block' }
  if (/^(javascript|vbscript|data|blob|file):/i.test(raw)) return { action: 'block' }

  let url
  try {
    url = new URL(raw, pageHref || undefined)
  } catch {
    return { action: 'block' }
  }
  if (url.username || url.password) return { action: 'block' }
  if (MAIL_PROTOCOLS.has(url.protocol)) return { action: 'mail', url: url.toString() }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { action: 'block' }

  let page = null
  try {
    page = pageHref ? new URL(pageHref) : null
  } catch {
    page = null
  }
  if (page && url.origin === page.origin) return { action: 'stay', url: url.toString() }
  return { action: 'system', url: url.toString() }
}

// An address the system browser is allowed to open. Absolute http(s)
// only, with no username or password. The caller has already decided
// the address should leave the parish WebView.
export function assertSystemHttpUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.username || parsed.password) return null
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.toString()
}

// A server checkout response gets its own strict boundary, separate from
// the general link policy: a non-empty string, absolute http(s), no
// username or password, no control characters or surrounding spaces.
// Mail, phone, relative, fragment, blob and data addresses are refused.
export function validateCheckoutUrl(value) {
  if (typeof value !== 'string' || !value) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(value)) return null
  if (!/^https?:\/\/[^/\\]/i.test(value)) return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password || !parsed.hostname) return null
  return parsed.toString()
}

// An export the app itself generated: an anchor with a download
// attribute whose href is a blob: URL minted by this page's origin.
// Only that exact shape is trusted; other blob or data links stay blocked.
export function isTrustedAppDownload(anchor, pageHref) {
  if (!anchor || typeof anchor.hasAttribute !== 'function' || !anchor.hasAttribute('download')) return false
  const href = anchor.getAttribute('href')
  if (typeof href !== 'string' || !href.startsWith('blob:')) return false
  try {
    const inner = new URL(href.slice(5))
    const page = new URL(pageHref)
    return inner.origin !== 'null' && inner.origin === page.origin
  } catch {
    return false
  }
}

export function externalClickDecision(event, pageHref) {
  if (!event || event.defaultPrevented) return { action: 'ignore' }
  const button = event.button ?? 0
  if (button !== 0) return { action: 'ignore' }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return { action: 'ignore' }
  const anchor = event.target?.closest?.('a[href]')
  if (!anchor) return { action: 'ignore' }
  if (isTrustedAppDownload(anchor, pageHref)) return { action: 'ignore' }
  const decision = classifyAwayNavigation(anchor.getAttribute('href'), pageHref)
  if (decision.action === 'stay') return { action: 'ignore' }
  return decision
}
