import { useEffect, useState } from 'react'
import { apiUrl } from '../api'

// Module-level cache keyed by ISO date. Two consumers on the same page
// (Dashboard mounts both LiturgicalWidget and LiturgicalDayDetail) used
// to fire two identical GETs on mount and keep two independent copies of
// the same answer. One cache, one fetch in flight, single source of truth.
const cache = new Map()       // date -> resolved data (successful reads only)
const inflight = new Map()    // date -> Promise<data|null>

function todayLocalISO() {
  // Local date so "today" matches the user's calendar, not UTC's.
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function fetchOnce(date) {
  if (cache.has(date)) return Promise.resolve(cache.get(date))
  if (inflight.has(date)) return inflight.get(date)
  const p = fetch(apiUrl(`/api/liturgical?date=${date}`))
    .then(r => r.ok ? r.json() : null)
    .catch(() => null)
    .then(d => {
      // Only a real answer is remembered. A failed read is not the day's
      // answer: caching it would hide the card for the rest of the session
      // after one network blip, so the next mount asks again.
      if (d) cache.set(date, d)
      inflight.delete(date)
      return d
    })
  inflight.set(date, p)
  return p
}

// Returns { data, today, error } where `error` is true when the fetch
// resolved to null (network error or non-200). Consumers self-hide on
// error so a missing answer never pushes the Dashboard layout around.
export function useLiturgicalToday() {
  const today = todayLocalISO()
  const [data, setData] = useState(() => cache.get(today) ?? null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchOnce(today).then(d => {
      if (cancelled) return
      if (!d) { setError(true); return }
      setData(d)
    })
    return () => { cancelled = true }
  }, [today])

  return { data, today, error }
}
