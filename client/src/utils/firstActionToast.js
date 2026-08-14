// First-action delight. The first time a user creates a member,
// event, or task in this browser, fire a warm toast that names the
// moment instead of leaving the create silent. Subsequent creates
// stay quiet — we don't want to chime on every save.
//
// Per-browser via localStorage. Not per-user; the cost of someone on
// a different device seeing the toast a second time is exactly zero.
// localStorage keys live alongside the auth token under the same
// "ochr_" prefix, which the ecosystem conventions require.
//
// Wording is intentionally church-toned, not SaaS-cheery. The
// difference between "Welcome aboard. Your first member is on the
// roster." and "✨ Awesome! 🎉" is the difference between
// Parchment & Brass and any other CRM in the App Store.

const KEY_PREFIX = 'ochr_first_'

const COPY = {
  member: 'Welcome aboard. Your first member is on the roster.',
  event:  'First event on the books. The schedule is taking shape.',
  task:   'First task underway. The work begins.',
}

// `toast` is the useToast() hook return — needs `.success(message)`.
// Caller should already have it; we don't import the provider here
// to keep this util pure / SSR-safe (no React imports).
export function celebrateFirstAction(type, toast) {
  if (!type || !toast?.success) return false
  const message = COPY[type]
  if (!message) return false

  const key = `${KEY_PREFIX}${type}`
  try {
    if (localStorage.getItem(key)) return false
    localStorage.setItem(key, '1')
  } catch {
    // localStorage may be disabled (private browsing, locked-down
    // browsers). Failing closed means the user just doesn't get the
    // celebration — never fires twice though, since we couldn't read
    // the flag either. Acceptable degradation.
    return false
  }

  toast.success(message)
  return true
}
