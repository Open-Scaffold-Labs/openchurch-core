// Daily-verse service. Fetches a single verse from bible-api.com and
// caches it in-process for the rest of the calendar day. Without
// this every Dashboard load (per user, per device) hit bible-api.com
// directly — fine for one-off use, brutal at multi-tenant scale.
//
// Cache shape: a single { date, verse } record. When the request
// comes in on a new date, the old record is overwritten. No fixed
// TTL — the day boundary is the eviction signal.
//
// In serverless runtimes (Vercel) each function instance has its own
// cache, so cross-instance the call fanout is "max one per cold
// start per region per day" rather than zero. That's still a
// thousand-fold reduction vs per-user-per-load and keeps the
// abstraction stupid-simple. Promote to a DB or Redis cache if/when
// the request volume justifies it.

import { monitor } from '../monitoring/index.js'

// Same selection table as the (legacy) client-side picker so a given
// date produces the same verse server-side as the old client did.
const BOOKS = [
  'psalms', 'proverbs', 'john', 'romans', 'isaiah',
  'matthew', 'philippians', 'jeremiah',
]

const FALLBACK = {
  text:      'Be still, and know that I am God.',
  reference: 'Psalm 46:10',
}

// Today's calendar-date key. Local-time intentional so the verse
// "rolls" at midnight in the operator's timezone, matching what
// users see on the Dashboard.
function todayKey(now = new Date()) {
  return now.toDateString()
}

// Deterministic seed from a date — same input → same verse. Lets us
// honor the "everyone in the church sees the same verse today"
// promise the client used to enforce.
function seedFor(date = new Date()) {
  return (date.getFullYear() * 10000) + (date.getMonth() * 100) + date.getDate()
}

function queryFor(seed) {
  const book    = BOOKS[seed % BOOKS.length]
  const chapter = (seed % 10) + 1
  const verse   = (seed % 20) + 1
  return `${book} ${chapter}:${verse}`
}

// Fetch a verse from bible-api.com. Throws on transport/parse error
// — the caller is responsible for the fallback. Pulled out so the
// random-refresh path can reuse it without going through the cache.
export async function fetchVerseFor(seed) {
  const query = queryFor(seed)
  const res   = await fetch(`https://bible-api.com/${encodeURIComponent(query)}`)
  if (!res.ok) throw new Error(`bible-api responded ${res.status}`)
  const data = await res.json()
  if (!data?.text) throw new Error('bible-api returned no text')
  return {
    text:      data.text.trim(),
    reference: data.reference,
  }
}

// Module-level cache. Single slot — only today's verse matters; once
// the date changes, a fresh fetch overwrites it.
let cached = null

// Cached today's verse. The "front door" callers (the route handler)
// should use this. Returns the fallback verse if the upstream fetch
// fails, so the Dashboard never renders empty.
export async function getTodaysVerse() {
  const key = todayKey()
  if (cached && cached.date === key) return cached.verse
  try {
    const verse = await fetchVerseFor(seedFor())
    cached = { date: key, verse }
    return verse
  } catch (err) {
    monitor.error('daily-verse.fetch', err)
    // Don't cache the fallback — we want to retry on the next call.
    return FALLBACK
  }
}

// Random-refresh — bypasses the cache, hands back a different verse
// every time. Used by the explicit "refresh" button. Failures fall
// back to the same hardcoded verse so the UI stays graceful.
export async function fetchRandomVerse() {
  try {
    return await fetchVerseFor(Math.floor(Math.random() * 100000))
  } catch (err) {
    monitor.error('daily-verse.random', err)
    return FALLBACK
  }
}

// Test-only — lets the smoke suite reset the cache between checks.
// Not exported via index, so app code can't reach it accidentally.
export function _resetCacheForTests() {
  cached = null
}
