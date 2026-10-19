// What a client says it was looking at, reduced to a route TEMPLATE before
// it can reach a model, a log table or a support email. Query and fragment
// are cut; any percent-encoding at all is ambiguous (single, double,
// triple...) and fails closed to null rather than being decoded; characters
// outside a plain path alphabet fail closed; a segment with a digit or 24+
// characters becomes ':id'. A template is less identifying, not PII-free.
export function routeTemplate(raw) {
  if (typeof raw !== 'string' || raw.length > 512) return null
  const path = raw.split(/[?#]/)[0]
  if (!path.startsWith('/') || path.includes('%')) return null
  if (!/^[A-Za-z0-9\-_/.]*$/.test(path)) return null
  const out = path.split('/')
    .map(seg => (seg === '' ? '' : (/\d/.test(seg) || seg.length >= 24 ? ':id' : seg.toLowerCase())))
    .join('/')
  return out.slice(0, 120) || null
}
