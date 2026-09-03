import { useCallback, useEffect, useRef, useState } from 'react'

// useLoad — the smallest thing that can tell "there is nothing" apart from
// "we do not know". (Pass 7 §4)
//
// The parish app has 43 <EmptyState> call sites and, before this pass, no
// shared way to say a read failed. 54 pages fetch; 34 track a load error;
// 26 render it. The recurring shape is
//
//     .then(r => r.ok ? r.json() : { records: [] })
//
// which converts every 500 into a welcome screen. That is not a fetching
// problem — fetching works fine. It is a vocabulary problem, so this is a
// vocabulary, not a data layer.
//
// THE TWO RULES THIS ENFORCES BY CONSTRUCTION:
//
//   1. `empty` is reachable only from a SUCCESSFUL read.
//
//      A failure with no prior data is `failed`. A failure with prior data
//      keeps the prior data and marks it stale. There is no path from a
//      rejected promise to an empty state, which is the path every one of
//      these defects took.
//
//   2. DATA BELONGS TO THE KEY IT WAS FETCHED FOR.
//
//      Rule 1 says stale data may stay on screen. That is right for a
//      REFRESH and wrong for a different dataset, and until now the hook
//      could not tell those apart: `deps` changing re-ran the fetcher, but
//      `hasData` was still true, so the state stayed 'ready' and the PREVIOUS
//      dataset rendered under the NEW label for the whole of the new load —
//      and, if the new read failed, kept rendering there indefinitely, marked
//      merely stale.
//
//      On a finance page that is last week's money under this week's heading,
//      with no indication that the two do not belong together. A number that
//      is late is a fact about lateness. A number filed under the wrong period
//      is a false statement, and no amount of visual continuity is worth one.
//
//      So data now carries the identity of the request that produced it, and
//      is surfaced only while that identity still matches. A key change means
//      'loading', every time. Correctness outranks visual continuity.
//
//      SAME KEY + REFRESH FAILURE  → last known truthful data may remain, stale.
//      DIFFERENT KEY               → the old data is gone; nothing wears the new label.
//
// Returns:
//   state     'loading' | 'ready' | 'empty' | 'failed' | 'idle'
//             'idle' only when enabled:false — we have not asked
//   data      whatever the fetcher resolved, or the initial value
//   error     the cause, when the last attempt failed
//   isStale   we have data, and the most recent attempt to refresh it failed
//   reload()  re-runs the fetcher; resolves true on success, false on failure
//   retrying  a reload is in flight while data is already on screen
//
// Deliberately NOT here, and each omission is a decision:
//   - no cache        two callers wanting the same rows is not this problem
//   - no dedup        no request volume problem has been observed
//   - no global store  the failure was local to each page and so is the fix
//   - no partial-failure machinery — a page with two panels uses two
//     useLoads, and Notifications proves that is enough
//   - no cache, still: a key change DISCARDS the old dataset rather than
//     filing it. Coming back to key A refetches A. Keeping both would be a
//     cache, with a cache's invalidation problem, to save one spinner.
//
// Adoption is per call site. Nothing here is registered, provided, or
// wrapped around the app.

const defaultIsEmpty = (d) =>
  d == null || (Array.isArray(d) ? d.length === 0 : false)

export function useLoad(fetcher, deps = [], options = {}) {
  const {
    initial = null,
    isEmpty = defaultIsEmpty,
    enabled = true,
    // The dataset's identity. Defaults to `deps`, which is already the
    // thing a caller changes when it wants different rows, so almost every
    // existing call site gets rule 2 without being touched. Pass `key`
    // explicitly when deps carry something that changes without changing
    // WHICH dataset is wanted (a retry counter is the usual case).
    key,
  } = options

  // Serialised so identity is compared by value, not by array identity —
  // `deps` is a new array on every render. JSON.stringify covers the
  // primitives these deps are in practice; the fallback keeps a caller who
  // passes something exotic working rather than throwing inside a hook.
  const identity = key !== undefined ? key : deps
  let identityKey
  try { identityKey = JSON.stringify(identity) } catch { identityKey = String(identity) }

  // ONE state object, not four.
  //
  // key/data/has/error must move together: a render that saw the new key
  // with the old data — or the old error against the new key — is exactly
  // the defect this is closing, and separate useStates make that
  // intermediate render reachable.
  const [entry, setEntry] = useState({ key: null, data: initial, has: false, error: null })
  const [loading, setLoading]   = useState(enabled)
  const [retrying, setRetrying] = useState(false)

  // Data counts as ours only while it belongs to the identity being asked
  // for now. This is a RENDER-TIME comparison, deliberately: an effect that
  // reset the state would leave one render in which the old data is still
  // 'ready' under the new key, and one render is enough to be seen and
  // screenshotted.
  const belongs = entry.has && entry.key === identityKey
  const errorHere = entry.error && entry.key === identityKey ? entry.error : null

  const seq   = useRef(0)
  const alive = useRef(true)
  // A render-synchronised mirror of `entry`, so run() can ask "do we already
  // hold rows for this key?" without a state updater.
  //
  // The first version asked inside setEntry(prev => …) and called
  // setLoading/setRetrying from in there. A state updater must be pure —
  // StrictMode invokes it twice in development precisely to surface that —
  // so the flags were being set twice per call. Reading a ref is the same
  // answer with none of that.
  const entryRef = useRef(null)
  entryRef.current = entry
  // `initial` is frequently written inline (`{ initial: [] }`), which is a
  // new value every render; through a ref it cannot destabilise run().
  const initialRef = useRef(initial)
  initialRef.current = initial
  // `alive` must be RESET on mount, not only cleared on unmount. React 19's
  // StrictMode mounts, unmounts and remounts every component in development;
  // the cleanup set alive=false and nothing ever set it back, so every state
  // update after the first simulated unmount was silently dropped and the
  // page span forever.
  //
  // Caught by looking at the running app, not by the tests — testing-library
  // does not wrap in StrictMode, so all 69 of them were green while
  // /notifications sat on a spinner. A green suite is not a working page.
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // The fetcher is called through a ref so a caller can write it inline
  // without the effect re-running on every render.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  // The key the in-flight request was started for, read inside run() rather
  // than closed over, so a late response is filed against the key it
  // actually asked about.
  const keyRef = useRef(identityKey)
  keyRef.current = identityKey

  const run = useCallback(async () => {
    const mine = ++seq.current
    const forKey = keyRef.current
    // Only the FIRST load of a given dataset blocks. A refresh of data we
    // already hold for THIS key leaves what is on screen alone; a load for a
    // key we hold nothing for is a first load, however much we hold for
    // some other key.
    const held = entryRef.current
    if (held && held.has && held.key === forKey) setRetrying(true)
    else setLoading(true)
    try {
      const value = await fetcherRef.current()
      if (!alive.current || mine !== seq.current) return true
      setEntry({ key: forKey, data: value, has: true, error: null })
      return true
    } catch (err) {
      if (!alive.current || mine !== seq.current) return false
      const message = err?.message || 'Failed to load'
      setEntry(prev => (
        // Same key and we already had rows: KEEP them and mark stale. The
        // data on screen is older than the truth, which is a fact;
        // replacing it with nothing would be a claim.
        prev.has && prev.key === forKey
          ? { ...prev, error: message }
          // Different key — there is nothing here that belongs to what is
          // being asked for, so there is nothing to keep. Whatever the
          // previous key's rows were, they are not an answer to this
          // question.
          : { key: forKey, data: initialRef.current, has: false, error: message }
      ))
      return false
    } finally {
      if (alive.current && mine === seq.current) { setLoading(false); setRetrying(false) }
    }
  }, [])

  useEffect(() => {
    if (!enabled) { setLoading(false); return }
    run()
    // Caller-declared deps, plus `enabled` and the dataset identity.
    // `run` is intentionally excluded: it is stable, and re-running on its
    // identity is not a reason to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, identityKey])

  // 'idle' is a fifth name for a real fifth condition: we have not asked.
  // It exists because hooks cannot be called conditionally, so a page that
  // gates its own read (Notifications is admin-only) must still call this.
  // Folding that into 'loading' would spin forever, and folding it into
  // 'empty' would be the exact lie this hook was built to stop — claiming
  // nothing exists when nothing was requested.
  //
  // Note what `belongs` does to this table: with a changed key it is false,
  // so the first three branches decide and neither 'ready' nor 'empty' is
  // reachable until a read for the CURRENT key has come back.
  const state =
    !enabled && !belongs ? 'idle'
    : loading && !belongs ? 'loading'
    : errorHere && !belongs ? 'failed'
    : belongs && isEmpty(entry.data) ? 'empty'
    : belongs ? 'ready'
    : 'loading'

  return {
    state,
    // Gated on the key too. A caller that reads `data` directly — LoadState
    // hands it to children(), and several pages destructure it — must never
    // receive the previous dataset while the label says otherwise.
    data: belongs ? entry.data : initial,
    error: errorHere,
    // True only when we are showing data we could not just re-confirm, and
    // only when that data is an answer to the question currently being
    // asked. A failure after a key change is `failed`, never `stale`:
    // there is nothing on screen for it to be stale about.
    isStale: belongs && !!errorHere,
    reload: run,
    retrying,
  }
}
