// @sentry/node 10 still puts the incoming request on every error when
// sendDefaultPii is false. That payload is the URL (query and capability
// tokens in the path), headers, and parsed cookies. These hooks run on
// the event about to leave the process. The stack and the route pattern stay.

// Headers worth keeping for a stack trace. Everything else — Cookie,
// Authorization, Referer (invite and reset tokens), proxy and webhook
// signatures, API keys, Vercel geo — is dropped. A denylist kept missing
// new secret header names.
const ALLOWED_REQUEST_HEADERS = new Set([
  'host',
  'user-agent',
  'accept',
  'content-type',
  'content-length',
])

// A URL with a query: scheme://path?query, or a path that starts with /.
// Prose that merely contains '?' is left alone.
function stripUrlQueries(value) {
  return value.replace(
    /(?:https?:\/\/[^\s?#]+|\/[^\s?#]*)\?[^\s#]*/gi,
    (match) => match.slice(0, match.indexOf('?')),
  )
}

// Fresh regexes per call. A shared /g pattern keeps lastIndex across uses.
function redactTokenPaths(value) {
  return value
    .replace(/\/api\/kiosk\/[^/?#\s]+/g, '/api/kiosk/:token')
    .replace(/\/api\/swap\/by-token\/[^/?#\s]+/g, '/api/swap/by-token/:token')
    .replace(/\/api\/calendar-sync\/[^/?#\s]+\.ics/g, '/api/calendar-sync/:token.ics')
    .replace(/\/api\/unsubscribe\/[^/?#\s]+/g, '/api/unsubscribe/:token')
}

export function scrubText(value) {
  if (typeof value !== 'string') return value
  return redactTokenPaths(stripUrlQueries(value))
}

function scrubUnknown(value, depth) {
  if (depth > 8) return value
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map((item) => scrubUnknown(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  for (const key of Object.keys(value)) {
    value[key] = scrubUnknown(value[key], depth + 1)
  }
  return value
}

function isQueryAttribute(key) {
  const lower = String(key).toLowerCase()
  return lower === 'query_string'
    || lower === 'query'
    || lower.endsWith('.query')
    || lower.endsWith('_query')
}

function isIpAttribute(key) {
  const lower = String(key).toLowerCase()
  return lower === 'http.client_ip'
    || lower === 'net.peer.ip'
    || lower.endsWith('ip_address')
    || lower.includes('forwarded')
    || lower.includes('real_ip')
    || lower.includes('client_ip')
}

function isSensitiveAttributeKey(key) {
  const dashed = String(key).toLowerCase().replace(/_/g, '-')
  if (dashed.includes('cookie')) return true
  if (dashed.includes('authorization')) return true
  if (dashed.includes('session')) return true
  if (dashed.includes('token')) return true
  if (dashed.includes('api-key') || dashed.includes('apikey')) return true
  if (dashed.includes('signature')) return true
  if (dashed.includes('kiosk-code')) return true
  return false
}

// Span attributes name headers as http.request.header.cookie or
// http.request.header.content_type. Subkeys (cookie.ochr_session) follow.
function headerAttributeName(key) {
  const lower = String(key).toLowerCase()
  const marker = 'header.'
  const at = lower.indexOf(marker)
  if (at === -1) return null
  let rest = lower.slice(at + marker.length)
  const dot = rest.indexOf('.')
  if (dot !== -1) rest = rest.slice(0, dot)
  return rest.replace(/_/g, '-')
}

function scrubHeaderBag(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return
  for (const name of Object.keys(headers)) {
    if (!ALLOWED_REQUEST_HEADERS.has(String(name).toLowerCase())) {
      delete headers[name]
      continue
    }
    headers[name] = scrubUnknown(headers[name], 0)
  }
}

function scrubRequest(request) {
  if (!request || typeof request !== 'object') return
  delete request.cookies
  delete request.data
  scrubHeaderBag(request.headers)
  if (typeof request.url === 'string') request.url = scrubText(request.url)
  if ('query_string' in request) delete request.query_string
}

function scrubAttributeBag(bag) {
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return
  for (const key of Object.keys(bag)) {
    const headerName = headerAttributeName(key)
    if (
      (headerName && !ALLOWED_REQUEST_HEADERS.has(headerName))
      || isQueryAttribute(key)
      || isSensitiveAttributeKey(key)
      || isIpAttribute(key)
    ) {
      delete bag[key]
      continue
    }
    bag[key] = scrubUnknown(bag[key], 0)
  }
}

export function scrubSentryBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== 'object') return breadcrumb
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = scrubText(breadcrumb.message)
  }
  if (breadcrumb.data && typeof breadcrumb.data === 'object') {
    scrubHeaderBag(breadcrumb.data.headers)
    if ('cookies' in breadcrumb.data) delete breadcrumb.data.cookies
    // Request bodies. Console breadcrumbs keep data.arguments, scrubbed below.
    if ('data' in breadcrumb.data && breadcrumb.category !== 'console') {
      delete breadcrumb.data.data
    }
    scrubAttributeBag(breadcrumb.data)
  }
  return breadcrumb
}

function scrubSpan(span) {
  if (!span || typeof span !== 'object') return
  if (typeof span.description === 'string') span.description = scrubText(span.description)
  scrubAttributeBag(span.data)
  scrubAttributeBag(span.attributes)
}

function scrubException(exception) {
  if (!exception || typeof exception !== 'object' || !Array.isArray(exception.values)) return
  for (const entry of exception.values) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.value === 'string') entry.value = scrubText(entry.value)
    const frames = entry.stacktrace?.frames
    if (!Array.isArray(frames)) continue
    for (const frame of frames) {
      // Local-variable capture can put a path token on the frame.
      if (frame && typeof frame === 'object') delete frame.vars
    }
  }
}

export function scrubSentryEvent(event) {
  if (!event || typeof event !== 'object') return event
  if (typeof event.transaction === 'string') event.transaction = scrubText(event.transaction)
  if (typeof event.message === 'string') event.message = scrubText(event.message)
  if (event.request) scrubRequest(event.request)
  if (event.user && typeof event.user === 'object') delete event.user.ip_address
  scrubException(event.exception)
  if (Array.isArray(event.breadcrumbs)) {
    for (const breadcrumb of event.breadcrumbs) scrubSentryBreadcrumb(breadcrumb)
  }
  if (Array.isArray(event.spans)) {
    for (const span of event.spans) scrubSpan(span)
  }
  const trace = event.contexts?.trace
  if (trace && typeof trace === 'object') {
    if (typeof trace.description === 'string') trace.description = scrubText(trace.description)
    scrubAttributeBag(trace.data)
  }
  scrubHeaderBag(event.contexts?.response?.headers)
  return event
}

// `extra` is the test transport. Privacy fields are applied after it, so a
// caller cannot turn the scrubbers off or set sendDefaultPii.
// Tracing is not enabled here. Production does not sample traces.
export function buildSentryInitOptions(dsn, extra = {}) {
  return {
    ...extra,
    dsn,
    sendDefaultPii: false,
    beforeSend(event) {
      return scrubSentryEvent(event)
    },
    beforeSendTransaction(event) {
      return scrubSentryEvent(event)
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubSentryBreadcrumb(breadcrumb)
    },
  }
}
