// Shared formatting helpers used across pages.

// Up to two initials from a name, uppercased. Handles missing names and
// extra whitespace safely so avatar fallbacks never crash.
export function initials(name = '') {
  return (name || '')
    .split(' ')
    .map(n => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

// A load that either worked or didn't, for the parish client.
//
// The diocese app got this first (client-diocese/src/utils/format.js) after
// nearly every page there turned a dropped connection into a business fact.
// The parish app has the same shape in fewer places, and the ones that matter
// most are the pickers: `.catch(() => setMembers([]))` produces an empty
// <select>, and an empty member picker does not read as "we could not load
// your members". It reads as "you have no members" — to an administrator
// halfway through recording somebody's pledge.
//
// Returns { ok, data }. `ok` is false for a network error, a non-2xx, or a
// body that is not the shape asked for. The caller decides what to show;
// what it must not do is quietly substitute emptiness.
// A members roster is an array of member records. HTTP 200 with `{}`,
// `null`, a scalar, `{ clients: [...] }`, or a nested array such as
// `[[member]]` is a body this screen cannot read — not an empty parish.
// Callers that used `body.clients ?? []` turned that object into "no
// members". A nested array used to pass the array check and then render
// as a member with no name.
function isMemberRecord(row) {
  return row !== null && typeof row === 'object' && !Array.isArray(row)
}

export function asMemberRoster(body) {
  if (!Array.isArray(body)) return { ok: false, members: [] }
  if (body.some(row => !isMemberRecord(row))) return { ok: false, members: [] }
  return { ok: true, members: body }
}

// Render gate. `null` is "not loaded yet" (the dashboard's first paint).
// A present non-array, or an explicit failed read, must not say the roll
// is empty. `failed` covers a load that already substituted `[]`.
export function memberRosterUnreadable(members, failed = false) {
  if (failed) return true
  return members != null && !Array.isArray(members)
}

export async function loadList(url, pick = d => d) {
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, data: [] }
    const body = await res.json()
    const roster = asMemberRoster(pick(body))
    if (!roster.ok) return { ok: false, data: [] }
    return { ok: true, data: roster.members }
  } catch {
    return { ok: false, data: [] }
  }
}

// The single-object sibling of loadList. Stats endpoints, summaries and
// detail rows are not arrays, so loadList rejects them outright — which used
// to push callers back to a bare `.then(r => r.json())` and straight into the
// failure this file exists to prevent.
//
// Returns { ok, data }. `ok: false` means "we do not know", and the caller is
// expected to say so rather than render `fallback` as though it were an
// answer. That distinction is the whole point: UNKNOWN is not EMPTY.
// loadList already refuses a body that is not an array. loadOne did not
// refuse anything, and that asymmetry had a cost: on 27 Aug a 200 carrying
// the wrong shape for /api/tasks/stats made `stats` an empty ARRAY, which is
// truthy, so `parseInt(stats.completed)` was NaN and the Daily Tasks page
// rendered "NaN%" progress to the parish with no warning at all. A wrong
// number presented confidently is worse than an error — the person has no
// way to know not to trust it.
//
// So a successful response must also be the SHAPE the caller asked for.
// Every caller in this app reads named fields off an object, hence the
// default. NOTE: client-diocese has its own loadOne whose second argument is
// a PICKER, not a fallback — same name, different contract. Do not assume
// this one behaves like that one.
export async function loadOne(url, fallback = null, isValid = v => v !== null && typeof v === 'object' && !Array.isArray(v)) {
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, data: fallback }
    const body = await res.json()
    if (!isValid(body)) return { ok: false, data: fallback }
    return { ok: true, data: body }
  } catch {
    return { ok: false, data: fallback }
  }
}

// A write that reports what actually happened.
//
// The failure this exists to stop: `await fetch(url, {method:'DELETE'})`
// followed by a refetch. A 403 from the write gate, a 404, a 500 — all
// discarded. The list reloads with the row still in it, the confirm dialog
// has already closed, and the person is left believing a destructive action
// succeeded. Tasks even said "This cannot be undone" first.
//
// Returns { ok, data, error }. Never throws; a network failure is an error
// value like any other, because a caller that has to remember try/catch is a
// caller that will forget.
export async function mutate(url, { method = 'POST', body } = {}) {
  let res
  try {
    res = await fetch(url, {
      method,
      ...(body !== undefined ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      } : {}),
    })
  } catch {
    return { ok: false, data: null, error: "Couldn't reach the server. Nothing was changed." }
  }

  let data = null
  try { data = await res.json() } catch { /* 204, or an empty body — fine */ }

  if (!res.ok) {
    return {
      ok: false,
      data,
      // The server's own message when it gave one; it knows more than we do.
      // The status code stays in the fallback so a support ticket can say
      // something more useful than "it did not work".
      error: data?.error || `That didn't go through (${res.status}).`,
    }
  }
  return { ok: true, data, error: null }
}
