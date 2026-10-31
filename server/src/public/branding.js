// Public parish branding for /p/:slug (OC-WEB-1 PR-A).
//
// Parish rows may leave the branding columns null. The public page must
// still render with a real palette — OpenChurch's Parchment & Brass —
// rather than inventing colors in the browser or 500ing on bad data.
// Every value that reaches the visitor is resolved here: unsafe logos and
// malformed accents fall back to defaults instead of being echoed.

// Church Burgundy — docs/BRAND.md / tailwind `church-900`.
export const DEFAULT_ACCENT_HEX = '#5A1E23'

const HEX_RE = /^#[0-9A-Fa-f]{6}$/
const MAX_DISPLAY_NAME = 120
const MAX_LOGO_URL = 500

export function isSafeAccentHex(value) {
  return typeof value === 'string' && HEX_RE.test(value.trim())
}

// Public pages may only embed https logos. javascript:/data:/http: are
// rejected so a compromised admin row cannot turn the parish homepage
// into an XSS vector for anonymous visitors.
export function isSafeHttpsLogoUrl(value) {
  if (typeof value !== 'string') return false
  const raw = value.trim()
  if (!raw || raw.length > MAX_LOGO_URL) return false
  let u
  try { u = new URL(raw) } catch { return false }
  if (u.protocol !== 'https:') return false
  // Block credentials in the URL userinfo and obvious script schemes that
  // a loose parser might have already accepted.
  if (u.username || u.password) return false
  return true
}

export function resolvePublicBranding(org) {
  const name = typeof org?.name === 'string' ? org.name : ''
  const rawDisplay = typeof org?.public_display_name === 'string'
    ? org.public_display_name.trim()
    : ''
  const display_name = (rawDisplay && rawDisplay.length <= MAX_DISPLAY_NAME)
    ? rawDisplay
    : name

  const rawLogo = typeof org?.public_logo_url === 'string'
    ? org.public_logo_url.trim()
    : ''
  const logo_url = isSafeHttpsLogoUrl(rawLogo) ? rawLogo : null

  const rawAccent = typeof org?.public_accent_hex === 'string'
    ? org.public_accent_hex.trim()
    : ''
  const accent_hex = isSafeAccentHex(rawAccent)
    ? rawAccent.toUpperCase()
    : DEFAULT_ACCENT_HEX

  const using_defaults = (
    display_name === name &&
    logo_url === null &&
    accent_hex === DEFAULT_ACCENT_HEX
  )

  return { display_name, logo_url, accent_hex, using_defaults }
}
