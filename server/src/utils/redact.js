// ARG-LEAK-2: log-safe renderings of personal data. Logs keep enough to
// debug ("a***@e***.com", a count) and never a full address, token or URL.

export function maskEmail(addr) {
  if (addr == null) return '(none)'
  const s = String(addr).trim()
  const at = s.lastIndexOf('@')
  if (at < 1) return '***'
  const local = s.slice(0, at)
  const domain = s.slice(at + 1)
  const dot = domain.lastIndexOf('.')
  const tld = dot > 0 ? domain.slice(dot) : ''
  return `${local[0]}***@${domain ? domain[0] : ''}***${tld}`
}

export function maskRecipients(to) {
  const list = Array.isArray(to) ? to : [to]
  return list.map(maskEmail).join(', ')
}

// S-F2: provider ids (session, payment ref, charge) are bearer-ish handles
// into the payment provider; keep a short prefix for correlation only.
export function maskRef(ref) {
  if (ref == null) return '(none)'
  const s = String(ref)
  return s.length <= 8 ? '***' : `${s.slice(0, 8)}***`
}

// S-F3: request paths carry unsubscribe / swap / invite tokens as segments.
// Any segment that looks like a token (16+ url-safe chars) becomes ':token'.
export function maskPath(p) {
  if (p == null) return ''
  return String(p).split('?')[0].split('/')
    .map(seg => /^[A-Za-z0-9._~%+=-]{16,}$/.test(seg) ? ':token' : seg).join('/')
}

// Strip URLs and long token-like runs from free text such as a subject.
export function scrubText(s) {
  if (s == null) return ''
  return String(s)
    .replace(/\bhttps?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9_\-+/=]{20,}/g, '[redacted]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, m => maskEmail(m))
}
