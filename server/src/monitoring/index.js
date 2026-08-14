// Vendor-neutral monitoring/logging interface. Today the dispatch
// implementation just writes structured JSON to stderr (errors/warns)
// or stdout (info/debug) — Vercel logs grok this fine and so do
// log-aggregation tools. Tomorrow, when the team lead picks Sentry /
// Axiom / Datadog / etc, the only thing that changes is the
// `dispatch()` function in this file. Every callsite stays put.
//
// Same vendor-neutral pattern as billing/email/notification-transport.
//
// Usage:
//   import { monitor } from '../monitoring/index.js'
//
//   try { … }
//   catch (err) {
//     monitor.error('audit.write', err, { recipient: row.email })
//   }
//
// Scopes use dot-notation (subsystem.surface). Loose enough to evolve,
// structured enough to filter on once a real backend is wired in.
//
// NOTE: This commit migrated the silent / system-level callsites
// (fire-and-forget catches, middleware-level errors, db pool errors,
// boot-level uncaught/unhandled handlers). Plain `console.error(err);
// res.status(500)…` paths in route handlers still log to stderr —
// they're not silent (the user sees a 500) so the migration was
// deferred to keep this change surgical. New routes should call
// monitor.error directly.

const LEVEL_ORDER = { error: 50, warn: 40, info: 30, debug: 20 }

// Optional Sentry sink. Env-gated and softly-dependent: if SENTRY_DSN is
// set we try to dynamically import '@sentry/node' and init it once. If the
// package isn't installed (it's not a hard dependency), we log one warning
// and fall back to the stdout/stderr behavior below — never crash. When it
// loads, monitor.error ALSO forwards to Sentry.captureException with the
// scope + context as tags/extra, on top of the structured stderr log.
// Production-only: a DSN accidentally exported in a dev shell or CI must
// never ship local noise to the project. Dev/test keep pure structured
// logging even when SENTRY_DSN is present.
let sentry = null
if (process.env.SENTRY_DSN && process.env.NODE_ENV === 'production') {
  // Fire-and-forget: the import is async, so early errors (before Sentry
  // finishes loading) still get the structured-log path and just miss the
  // Sentry forward. Once resolved, `sentry` is set for subsequent calls.
  import('@sentry/node')
    .then((mod) => {
      const Sentry = mod.default ?? mod
      Sentry.init({ dsn: process.env.SENTRY_DSN })
      sentry = Sentry
      process.stdout.write(JSON.stringify({
        level: 'info', scope: 'monitoring.init', message: 'Sentry enabled',
        timestamp: new Date().toISOString(),
      }) + '\n')
    })
    .catch(() => {
      process.stderr.write(JSON.stringify({
        level: 'warn', scope: 'monitoring.init',
        message: 'SENTRY_DSN set but @sentry/node not installed — falling back to structured logging only',
        timestamp: new Date().toISOString(),
      }) + '\n')
    })
}

// Threshold for what gets emitted. Defaults to 'info' so warnings
// and errors always land; `debug` is opt-in via env.
const MIN_LEVEL = process.env.MONITORING_LEVEL ?? 'info'

function shouldLog(level) {
  const got  = LEVEL_ORDER[level]  ?? LEVEL_ORDER.info
  const need = LEVEL_ORDER[MIN_LEVEL] ?? LEVEL_ORDER.info
  return got >= need
}

// The single replaceable function. A real provider's adapter would
// shadow this with `Sentry.captureException(...)` etc. The contract:
// receive (level, scope, message, context) and decide what to do.
function dispatch(level, scope, message, context) {
  if (!shouldLog(level)) return
  const event = {
    level,
    scope,
    message,
    ...context,
    timestamp: new Date().toISOString(),
  }
  // Stringify defensively — a circular-reference context shouldn't
  // crash the logger.
  let line
  try { line = JSON.stringify(event) }
  catch { line = JSON.stringify({ level, scope, message, _serializeError: true }) }

  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
  else                                       process.stdout.write(line + '\n')
}

// Public API. Each method narrows the call shape so callers don't
// have to remember level strings.
export const monitor = {
  // For thrown / caught Errors. Pulls message + stack off the err
  // object automatically; merge any extra context the caller has.
  error(scope, err, context = {}) {
    const message = err?.message ?? String(err)
    const stack   = err?.stack
    dispatch('error', scope, message, { ...context, ...(stack ? { stack } : {}) })
    // Also forward to Sentry when enabled — the structured stderr log above
    // still happens either way. Guarded try/catch so a Sentry hiccup can't
    // break the logging path.
    if (sentry) {
      try {
        sentry.captureException(err instanceof Error ? err : new Error(message), {
          tags:  { scope },
          extra: context,
        })
      } catch { /* never let monitoring crash the caller */ }
    }
  },

  // For known-bad-but-non-fatal conditions. e.g. quota lookup that
  // failed — we let the call through but want to know.
  warn(scope, message, context = {}) {
    dispatch('warn', scope, message, context)
  },

  // For deliberate signals the operator may want to see. Cheap;
  // skip the higher-volume paths.
  info(scope, message, context = {}) {
    dispatch('info', scope, message, context)
  },
}

// Test seam — lets the smoke suite swap dispatch for an in-memory
// capture. Not exported via a top-level barrel, so app code has no
// reason to grab it accidentally.
export function _setDispatchForTests(fn) {
  const original = dispatch
  // Reassigning the module-local `dispatch` is fragile across
  // bundlers, so the test seam wraps the public methods instead.
  monitor.error = (scope, err, context = {}) => {
    const message = err?.message ?? String(err)
    fn('error', scope, message, { ...context, ...(err?.stack ? { stack: err.stack } : {}) })
  }
  monitor.warn = (scope, message, context = {}) => fn('warn', scope, message, context)
  monitor.info = (scope, message, context = {}) => fn('info', scope, message, context)
  return () => {
    // Restore the production-shape methods. The original `dispatch`
    // closure is captured here so we don't lose it.
    monitor.error = (scope, err, context = {}) => {
      const message = err?.message ?? String(err)
      const stack   = err?.stack
      original('error', scope, message, { ...context, ...(stack ? { stack } : {}) })
    }
    monitor.warn = (scope, message, context = {}) => original('warn', scope, message, context)
    monitor.info = (scope, message, context = {}) => original('info', scope, message, context)
  }
}
