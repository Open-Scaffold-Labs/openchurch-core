// Absolute origins for links that leave the building.
//
// A URL handed to something outside this process — a mail client, a
// calendar app, a person pasting it into a browser — must be absolute.
// Relative is not a degraded form of absolute; it is dead. `/api/x` has
// nothing to resolve against once it is in an inbox or a calendar
// subscription field, and it fails silently: the calendar simply never
// syncs, the header simply never works, and nothing is logged anywhere.
//
// This module exists because that failure already happened. vitest sets
// BASE_URL="/" for its own reasons, and the List-Unsubscribe header built
// from it read `</api/unsubscribe/…>` — a link a mail client cannot use,
// on a header that still advertised one-click support to Gmail. Nine
// places in this server build a URL from env, each with its own inline
// `|| default` and its own trailing-slash trim, and every one of them was
// vulnerable to the same "/" that caught the first.
//
// Two properties, both deliberate:
//
// READ AT CALL TIME, not at module load. Several of the original sites
// were `const CLIENT_URL = process.env.CLIENT_URL || …` at import. In
// serverless the platform can populate env after the module graph is
// built, so an import-time read is a read taken before the environment
// finished existing.
//
// NULL RATHER THAN A GUESS in production. Outside production a localhost
// default is useful and harmless. In production it is a dead link wearing
// a valid-looking shape, and the caller is better placed than this module
// to decide what to do about that — a header can be omitted, a response
// whose entire payload IS the URL cannot.

// Resolve one env var to an absolute origin with no trailing slash.
// Returns null when it cannot be made absolute and there is no safe
// fallback to offer.
export function absoluteBase(varName, devFallback) {
  const raw = String(process.env[varName] ?? '').trim().replace(/\/+$/, '')
  if (/^https?:\/\//i.test(raw)) return raw
  if (process.env.NODE_ENV === 'production') return null
  return devFallback
}

// Where this API answers. Used for anything an external system fetches
// back from us: ICS subscription feeds, unsubscribe endpoints.
export function apiBase() {
  return absoluteBase('BASE_URL', 'http://localhost:3034')
}

// Where the parish front end lives. Used for links a person clicks in an
// email: password resets, invitations, receipts.
export function clientBase() {
  return absoluteBase('CLIENT_URL', 'http://localhost:5202')
}

// Where the chancery front end lives. A diocese invitation must not drop
// a chancery user into the parish app.
export function dioceseClientBase() {
  return absoluteBase('DIOCESE_CLIENT_URL', 'http://localhost:5204')
}
