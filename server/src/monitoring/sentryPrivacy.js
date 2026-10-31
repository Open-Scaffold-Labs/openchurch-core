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

// Numeric and UUID path segments are record ids: /api/clients/123 -> /api/clients/:id.
// Path fields only. In prose the same rule rewrote a date: 2026/10/25 -> 2026/:id/:id.
function redactIdPaths(value) {
  return value.replace(
    /\/(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[/?#\s]|$)/gi,
    '/:id',
  )
}

// URL and route strings. Record ids stay `:id` so a route is still readable.
export function scrubText(value) {
  if (typeof value !== 'string') return value
  return redactIdPaths(redactTokenPaths(stripUrlQueries(value)))
}

const DATE_MARK = '\uE000'
const DATE_END = '\uE001'

function shieldDates(value) {
  const saved = []
  const stash = (match) => {
    const token = `${DATE_MARK}${saved.length}${DATE_END}`
    saved.push(match)
    return token
  }
  const shielded = value
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, stash)
    .replace(/\b\d{4}\/\d{2}\/\d{2}\b/g, stash)
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, stash)
  return { shielded, saved }
}

function restoreDates(value, saved) {
  return value.replace(
    new RegExp(`${DATE_MARK}(\\d+)${DATE_END}`, 'g'),
    (_match, index) => saved[Number(index)] ?? '',
  )
}

// Free text: emails, phones, long numbers, uuids, tokens, and URL queries.
// No path-id pass, so a slash date in a sentence stays a date.
function scrubProse(value) {
  if (typeof value !== 'string') return value
  let out = redactTokenPaths(stripUrlQueries(value))
  const shielded = shieldDates(out)
  out = shielded.shielded
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]')
  out = out.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, '[token]')
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[token]')
  out = out.replace(/\b(?:sk|pk|rk|ak)_(?:live|test)_[A-Za-z0-9]+\b/g, '[token]')
  out = out.replace(/\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token)\s*[=:]\s*[^\s,;]+/gi, '[token]')
  out = out.replace(/\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g, '[token]')
  out = out.replace(/(?<!\d)(?:\+\d{1,3}[\s.-])?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g, '[phone]')
  out = out.replace(/\+\d{1,3}(?:[\s.-]\d{2,4}){2,5}\b/g, '[phone]')
  out = out.replace(/\b\d{4}(?:[ -]\d{4}){2,4}\b/g, '[number]')
  out = out.replace(/\d{6,}/g, '[number]')
  // Labeled record ids are short (userId=17, org_id: 9, "organizationId": "44").
  // A bare count or a civil day has no label, so status 500 and client 42 stay.
  out = out.replace(
    /["']?\b(?:user|org|organization|parish|member|person|donor|family|household|client|target|ticket|receipt|parent|payment|gift|recurringgift|account|customer|staff|tenant|diocese|form|event|element|plan|object|storage|stripe|checkout|subscription|invoice|campaign|fund|pledge|sacrament|contact)[\s_.-]*(?:ids?|uuid|refs?|slug)\b["']?\s*[=:]\s*["']?[A-Za-z0-9_.:-]+["']?/gi,
    '[id]',
  )
  return restoreDates(out, shielded.saved)
}

function isPathKey(key) {
  const lower = String(key).toLowerCase().replace(/_/g, '.')
  if (lower === 'url' || lower === 'uri' || lower === 'path' || lower === 'route' || lower === 'target' || lower === 'transaction') return true
  if (lower.endsWith('.url') || lower.endsWith('.uri') || lower.endsWith('.path') || lower.endsWith('.target') || lower.endsWith('.route')) return true
  if (lower === 'url.full' || lower === 'http.url' || lower === 'http.target' || lower === 'http.route' || lower === 'http.path') return true
  return false
}

// Path rule first, so /123 and /<uuid> stay `:id`, then any secret left in the string.
function scrubPathField(value) {
  if (typeof value !== 'string') return value
  return scrubProse(scrubText(value))
}

function applyText(key, value) {
  if (typeof value !== 'string') return value
  return isPathKey(key) ? scrubPathField(value) : scrubProse(value)
}

function dropKey(holder, key) {
  try {
    delete holder[key]
  } catch {
    // Still do not leave the raw value as the thing that would be sent.
    try { holder[key] = undefined } catch { /* unwritable; caller drops the event */ }
  }
}

// Past this depth nothing is inspected, so nothing is sent.
const MAX_DEPTH = 8
const TRUNCATED = '[truncated]'

function scrubUnknown(value, depth, key = '') {
  try {
    if (depth > MAX_DEPTH) return value && typeof value === 'object' ? TRUNCATED : applyText(key, value)
    if (typeof value === 'string') return applyText(key, value)
    if (Array.isArray(value)) {
      const next = []
      for (const item of value) {
        try {
          next.push(scrubUnknown(item, depth + 1, typeof item === 'string' ? key : ''))
        } catch {
          next.push(undefined)
        }
      }
      return next
    }
    if (!value || typeof value !== 'object') return value
    for (const childKey of Object.keys(value)) {
      try {
        const next = scrubUnknown(value[childKey], depth + 1, childKey)
        if (next === undefined) delete value[childKey]
        else value[childKey] = next
      } catch {
        delete value[childKey]
      }
    }
    return value
  } catch {
    return undefined
  }
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
    try {
      const next = scrubUnknown(headers[name], 0, name)
      if (next === undefined) delete headers[name]
      else headers[name] = next
    } catch {
      delete headers[name]
    }
  }
}

function scrubRequest(request) {
  if (!request || typeof request !== 'object') return
  delete request.cookies
  delete request.data
  scrubHeaderBag(request.headers)
  if (typeof request.url === 'string') {
    try {
      request.url = scrubPathField(request.url)
    } catch {
      delete request.url
    }
  }
  if ('query_string' in request) delete request.query_string
}

// Sentry's own correlation ids end in "id" but are not a person or a parish.
function isTraceCorrelationKey(key) {
  const compact = keyTokens(key).join('_')
  return compact === 'trace_id' || compact === 'span_id' || compact === 'parent_span_id'
}

function scrubAttributeBag(bag) {
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return
  for (const key of Object.keys(bag)) {
    if (!isTraceCorrelationKey(key) && isIdentifierKey(key)) {
      delete bag[key]
      continue
    }
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
    try {
      const next = scrubUnknown(bag[key], 0, key)
      if (next === undefined) delete bag[key]
      else bag[key] = next
    } catch {
      delete bag[key]
    }
  }
}

// Keys that name a person, parish or record. Keys are split on camel, snake,
// kebab and dot boundaries and lowercased, so userId, user_id, USER-ID and
// User.Id all read as [user, id]. All-lowercase or all-caps compounds with no
// boundary (userid, PAYMENTREF) are caught by the entity-prefix rule below.
const IDENTIFIER_TOKENS = new Set([
  'id', 'ids', 'uuid', 'eid', 'ref', 'refs', 'slug', 'email', 'emails', 'phone',
  'recipient', 'recipients', 'username', 'session', 'key', 'keys',
])
const ENTITY_PREFIX = '(?:user|org|organization|parish|member|person|donor|family|household|client|target|ticket|receipt|parent|payment|gift|recurringgift|account|customer|staff|tenant|diocese|form|event|element|plan|object|storage|stripe|checkout|subscription|invoice|campaign|fund|pledge|sacrament|contact)'
const COMPOUND = new RegExp(`^${ENTITY_PREFIX}(?:ids?|uuid|refs?|slug|name|key|email)$`)

function keyTokens(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.\-]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase())
}

function isIdentifierKey(key) {
  const tokens = keyTokens(key)
  if (tokens.length === 0) return false
  const compact = tokens.join('')
  if (COMPOUND.test(compact)) return true
  if (compact.includes('email') || compact.includes('phone') || compact.includes('slug')) return true
  if (compact.includes('recipient') || compact.includes('username')) return true
  const last = tokens[tokens.length - 1]
  if (IDENTIFIER_TOKENS.has(last)) return true
  // user_name, USER_NAME, userName: a name tied to an entity.
  if (last === 'name' && tokens.length > 1 && COMPOUND.test(tokens.slice(0, -1).join('') + 'name')) return true
  return false
}

// Debugging fields an error report may keep in `extra`. Everything else is
// dropped, so a key added later (name, title, q, a new id) fails closed.
const EXTRA_ALLOWED = new Set([
  'scope', 'status', 'statuscode', 'code', 'errorcode', 'pgcode', 'count', 'total',
  'length', 'notificationtype', 'type', 'kind', 'category', 'provider', 'stage',
  'step', 'phase', 'route', 'method', 'model', 'priority', 'role', 'attempt',
  'lineno', 'colno', 'filename',
  'attempts', 'retry', 'retries', 'durationms', 'elapsedms', 'limit', 'size', 'received',
])

function isAllowedExtraKey(key) {
  const tokens = keyTokens(key)
  const compact = tokens.join('')
  if (EXTRA_ALLOWED.has(compact)) return true
  // qLength, itemCount, rowsTotal: a measured quantity, never an id.
  const last = tokens[tokens.length - 1]
  return tokens.length > 1 && (last === 'count' || last === 'length' || last === 'total')
}

function dropIdentifiers(value, depth) {
  if (!value || typeof value !== 'object') return
  const keys = Array.isArray(value) ? value.keys() : Object.keys(value)
  for (const key of keys) {
    if (!Array.isArray(value) && isIdentifierKey(key)) {
      delete value[key]
      continue
    }
    const child = value[key]
    if (child && typeof child === 'object') {
      if (depth >= MAX_DEPTH) value[key] = TRUNCATED
      else dropIdentifiers(child, depth + 1)
    }
  }
}

function scrubExtra(extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {}
  for (const key of Object.keys(extra)) {
    if (!isAllowedExtraKey(key) || isIdentifierKey(key)) delete extra[key]
  }
  dropIdentifiers(extra, 0)
  const scrubbed = scrubUnknown(extra, 0, 'extra')
  return scrubbed && typeof scrubbed === 'object' ? scrubbed : {}
}

// message / formatted / params. Throws so the caller can drop the whole field.
function scrubLogShape(entry) {
  if (typeof entry.message === 'string') entry.message = scrubProse(entry.message)
  if (typeof entry.formatted === 'string') entry.formatted = scrubProse(entry.formatted)
  if (typeof entry.params === 'string') {
    entry.params = scrubProse(entry.params)
    return
  }
  if (!Array.isArray(entry.params)) return
  entry.params = entry.params.map((item) => {
    if (typeof item === 'string') return scrubProse(item)
    if (item && typeof item === 'object') return scrubValueOrThrow(item, 0, 'param')
    return item
  })
}

function scrubCarrier(holder, key) {
  let raw
  try {
    raw = holder[key]
  } catch {
    dropKey(holder, key)
    return
  }
  if (typeof raw === 'undefined') return
  try {
    if (typeof raw === 'string') holder[key] = scrubProse(raw)
    else if (raw && typeof raw === 'object') scrubLogShape(raw)
  } catch {
    dropKey(holder, key)
  }
}

function scrubValueOrThrow(value, depth, key) {
  if (depth > MAX_DEPTH) {
    return value && typeof value === 'object' ? TRUNCATED : applyText(key, value)
  }
  if (typeof value === 'string') return applyText(key, value)
  if (Array.isArray(value)) {
    return value.map((item) => scrubValueOrThrow(item, depth + 1, typeof item === 'string' ? key : ''))
  }
  if (!value || typeof value !== 'object') return value
  const copy = {}
  for (const childKey of Object.keys(value)) {
    copy[childKey] = scrubValueOrThrow(value[childKey], depth + 1, childKey)
  }
  return copy
}

export function scrubSentryBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== 'object') return breadcrumb
  // console.* arguments are free text (rows, emails, errors). Keep only that
  // a console line happened, and at what level.
  if (breadcrumb.category === 'console') {
    delete breadcrumb.data
    breadcrumb.message = '[console]'
    return breadcrumb
  }
  if (typeof breadcrumb.message === 'string') {
    try {
      breadcrumb.message = scrubProse(breadcrumb.message)
    } catch {
      delete breadcrumb.message
    }
  }
  if (breadcrumb.data && typeof breadcrumb.data === 'object') {
    scrubHeaderBag(breadcrumb.data.headers)
    if ('cookies' in breadcrumb.data) delete breadcrumb.data.cookies
    // Request bodies.
    if ('data' in breadcrumb.data) delete breadcrumb.data.data
    scrubAttributeBag(breadcrumb.data)
    dropIdentifiers(breadcrumb.data, 0)
  }
  return breadcrumb
}

function scrubSpan(span) {
  if (!span || typeof span !== 'object') return
  if (typeof span.description === 'string') {
    try {
      span.description = scrubPathField(span.description)
    } catch {
      delete span.description
    }
  }
  scrubAttributeBag(span.data)
  scrubAttributeBag(span.attributes)
}

function scrubFrame(frame) {
  if (!frame || typeof frame !== 'object') return
  // Locals can hold a name, an address, or a sacramental fact that matches
  // no pattern. Drop the bag. Function, filename, line, and column stay.
  delete frame.vars
}

function scrubException(exception) {
  if (!exception || typeof exception !== 'object' || !Array.isArray(exception.values)) return
  for (const entry of exception.values) {
    if (!entry || typeof entry !== 'object') continue
    // `type` stays readable (QueryFailedError, HTTP code names). value is prose.
    for (const field of ['value', 'message']) {
      if (typeof entry[field] === 'string') {
        try {
          entry[field] = scrubProse(entry[field])
        } catch {
          delete entry[field]
        }
      }
    }
    const frames = entry.stacktrace?.frames
    if (!Array.isArray(frames)) continue
    for (const frame of frames) scrubFrame(frame)
  }
}

export function scrubSentryEvent(event) {
  if (!event || typeof event !== 'object') return event
  try {
    if (typeof event.transaction === 'string') {
      try {
        event.transaction = scrubPathField(event.transaction)
      } catch {
        delete event.transaction
      }
    }
    scrubCarrier(event, 'message')
    scrubCarrier(event, 'logentry')
    if (event.request) scrubRequest(event.request)
    // No setUser call exists; drop whatever an integration may attach.
    if ('user' in event) delete event.user
    if ('extra' in event) {
      try {
        event.extra = scrubExtra(event.extra)
      } catch {
        event.extra = {}
      }
    }
    dropIdentifiers(event.tags, 0)
    if (event.tags && typeof event.tags === 'object') {
      const next = scrubUnknown(event.tags, 0, 'tags')
      if (next === undefined) delete event.tags
      else event.tags = next
    }
    // trace_id / span_id in contexts.trace are Sentry's own, not a person's.
    if (event.contexts && typeof event.contexts === 'object') {
      for (const name of Object.keys(event.contexts)) {
        if (name === 'trace') continue
        try {
          dropIdentifiers(event.contexts[name], 0)
          const next = scrubUnknown(event.contexts[name], 0, name)
          if (next === undefined) delete event.contexts[name]
          else event.contexts[name] = next
        } catch {
          delete event.contexts[name]
        }
      }
    }
    try { scrubException(event.exception) } catch { delete event.exception }
    if (Array.isArray(event.breadcrumbs)) {
      const kept = []
      for (const breadcrumb of event.breadcrumbs) {
        try {
          const next = scrubSentryBreadcrumb(breadcrumb)
          if (next) kept.push(next)
        } catch { /* drop a crumb we could not scrub */ }
      }
      event.breadcrumbs = kept
    }
    if (Array.isArray(event.spans)) {
      const kept = []
      for (const span of event.spans) {
        try {
          scrubSpan(span)
          kept.push(span)
        } catch { /* drop a span we could not scrub */ }
      }
      event.spans = kept
    }
    const trace = event.contexts?.trace
    if (trace && typeof trace === 'object') {
      for (const key of Object.keys(trace)) {
        if (key === 'data' || key === 'description') continue
        if (isTraceCorrelationKey(key) || !isIdentifierKey(key)) continue
        delete trace[key]
      }
      if (typeof trace.description === 'string') {
        try {
          trace.description = scrubPathField(trace.description)
        } catch {
          delete trace.description
        }
      }
      scrubAttributeBag(trace.data)
    }
    scrubHeaderBag(event.contexts?.response?.headers)
    return event
  } catch {
    return null
  }
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
      try { return scrubSentryEvent(event) } catch { return null }
    },
    beforeSendTransaction(event) {
      try { return scrubSentryEvent(event) } catch { return null }
    },
    beforeBreadcrumb(breadcrumb) {
      try { return scrubSentryBreadcrumb(breadcrumb) } catch { return null }
    },
  }
}
