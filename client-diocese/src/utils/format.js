// Formatting the diocese app shares, so it stops disagreeing with itself.
//
// fmtMoney existed in four separate copies — Dashboard, Financials,
// Submissions and Assessments — each written `Number(v ?? 0)`. That turns a
// value that is missing because a request FAILED into a confident $0.00.
// The parish app's Finance.jsx got this right (`Finance.jsx:33` returns an
// em dash for anything non-finite); the diocese app was written later and
// copied the wrong version four times.
//
// A chancery looking at consolidated revenue is deciding whether a parish is
// in trouble. "$0.00" and "we could not load this" are opposite answers to
// that question, and only one of them is ever true when the fetch failed.

// Money, or an em dash. Never a zero it did not measure.
export const fmtMoney = v => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

// A whole count, or an em dash. Same argument.
export const fmtCount = v => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US')
}

// One loader for the pages that fetch several endpoints at once.
//
// Every diocese page was written `fetch(...).then(r => r.json()).catch(() =>
// setX([]))`. Two problems, and they compound: there is no `r.ok` check, so a
// 500 is parsed as if it were data; and the catch substitutes an EMPTY
// result, which every one of these pages renders as its "nothing here yet"
// state. A diocese with forty parishes whose request fails is told to invite
// its first one.
//
// Returns { data, failed } so a caller can render the difference. `failed` is
// the list of labels that did not load, so the page can say which part is
// missing rather than disclaiming the whole screen.
export async function loadAll(requests) {
  const entries = Object.entries(requests)
  const settled = await Promise.all(entries.map(async ([key, { url, pick }]) => {
    try {
      const res = await fetch(url)
      if (!res.ok) return [key, { ok: false }]
      const body = await res.json()
      return [key, { ok: true, value: pick ? pick(body) : body }]
    } catch {
      return [key, { ok: false }]
    }
  }))
  const data = {}, failed = []
  for (const [key, r] of settled) {
    if (r.ok) data[key] = r.value
    else failed.push(key)
  }
  return { data, failed }
}

// Single-endpoint version of the same idea.
//
// Returns { ok, data }. The caller decides what a failure looks like; what it
// must NOT do is call setRows([]) and let the page render "nothing here yet".
// `ok` is false for a network error, a non-2xx, or a body that is not JSON —
// all three used to be indistinguishable from an empty result.
export async function loadOne(url, pick) {
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, data: undefined }
    const body = await res.json()
    return { ok: true, data: pick ? pick(body) : body }
  } catch {
    return { ok: false, data: undefined }
  }
}

// Writes, with the answer read.
//
// Six handlers across this app were written `await fetch(url, {method})`
// followed immediately by `setNote('')` / `setSettling(null)` / `load()`.
// None of them looked at the response. A 500 therefore looked EXACTLY like a
// save: the textarea emptied, the panel closed, the list reloaded unchanged,
// and the person walked away believing the record had been written.
//
// That is the worst failure mode an office-of-record can have, and one of
// them — the shared note on a report review — makes the diocese believe it
// told a parish something it never told them.
//
// Returns { ok, data, error }. `ok` is true only when the server accepted it.
// Callers must not clear a field until they have seen `ok`.
export async function postJson(url, body, method = 'POST') {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? '{}' : JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, data, error: data.error || "That didn't save. Nothing was changed — try again." }
    }
    return { ok: true, data, error: '' }
  } catch {
    return { ok: false, data: {}, error: "That didn't save — we couldn't reach the server. Nothing was changed." }
  }
}
