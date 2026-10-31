// The browser has no Sentry SDK. These reports are the capture payload
// (ErrorBoundary, a page boundary, window.onerror, unhandledrejection).
// They pass through the same scrubber the server installs as beforeSend.
import { scrubSentryEvent } from '../../../server/src/monitoring/sentryPrivacy.js'

export function captureClientEvent(event) {
  try {
    return scrubSentryEvent(event)
  } catch {
    return null
  }
}

// Raw stack and componentStack text can carry identifiers in any format
// (component names, URL paths, query strings), so they never leave the
// browser. Only the top frame's file (no query or fragment) and line/col go.
export function stripUrlExtras(value) {
  if (typeof value !== 'string') return undefined
  return value.replace(/[?#].*$/s, '')
}

export function topFrame(stack) {
  if (typeof stack !== 'string') return {}
  for (const line of stack.split('\n')) {
    const m = line.match(/(?:\(|@|\bat\s+)([^\s()]+?):(\d+):(\d+)\)?\s*$/)
    if (m) return { filename: stripUrlExtras(m[1]), lineno: Number(m[2]), colno: Number(m[3]) }
  }
  return {}
}

export function reportBoundary(label, error, _info, scope) {
  const { filename, lineno, colno } = topFrame(error?.stack)
  console.error(label, captureClientEvent({
    message: error?.message ?? String(error ?? ''),
    tags: { scope },
    extra: { filename, lineno, colno },
  }))
}

export function reportWindowError(event) {
  console.error('[window.onerror]', captureClientEvent({
    message: event?.message ?? '',
    tags: { scope: 'window.onerror' },
    extra: {
      filename: stripUrlExtras(event?.filename),
      lineno: typeof event?.lineno === 'number' ? event.lineno : undefined,
      colno: typeof event?.colno === 'number' ? event.colno : undefined,
    },
  }))
}

export function reportUnhandledRejection(event) {
  const reason = event?.reason
  const message = reason instanceof Error ? reason.message : (reason == null ? '' : String(reason))
  console.error('[unhandledrejection]', captureClientEvent({
    message,
    tags: { scope: 'unhandledrejection' },
  }))
}
