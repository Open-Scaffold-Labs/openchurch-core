// Upstream provider errors are untrusted text: message, name, type, cause
// and stack can all echo the request (prompt text, key fragments). None of
// it is copied. What survives is a fixed provider label, a numeric HTTP
// status in 100..599, and a category from a closed list derived from that
// status — never from an upstream string.
const PROVIDER_LABELS = new Set(['anthropic', 'anthropic (org key)', 'openai (org key)'])

export const ERROR_CATEGORIES = ['auth', 'rate_limited', 'overloaded', 'bad_request', 'upstream_error', 'empty_response', 'unknown']

function categoryFor(status, upstream) {
  if (upstream === null) return 'empty_response'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limited'
  if (status === 529 || status === 503) return 'overloaded'
  if (status >= 400 && status < 500) return 'bad_request'
  if (status >= 500) return 'upstream_error'
  return 'unknown'
}

export function providerFailure(provider, upstream) {
  const label = PROVIDER_LABELS.has(provider) ? provider : 'provider'
  const raw = upstream?.status
  const status = Number.isInteger(raw) && raw >= 100 && raw <= 599 ? raw : null
  const category = categoryFor(status, upstream)
  const err = new Error(`${label} request failed${status ? ` (${status})` : ''} ${category}`)
  err.code = 'PROVIDER_FAILED'
  err.category = category
  err.httpStatus = status
  return err
}
