import { apiUrl } from '../api'

// Daily verse — server-first with two safety nets:
//   1. localStorage cache keyed by today's date string. Renders the
//      card instantly on reload before the network request resolves.
//      Skipped on `force` so the refresh button always re-fetches.
//   2. Direct bible-api.com fallback if the OpenChurch server is
//      unreachable (offline dev, server down, etc.). Preserves the
//      Dashboard's pre-cache behavior so we don't regress.

const CACHE_KEY = 'daily_verse'
const FALLBACK_BOOKS = [
  'psalms', 'proverbs', 'john', 'romans', 'isaiah',
  'matthew', 'philippians', 'jeremiah',
]

const FALLBACK_VERSE = {
  text:      'Be still, and know that I am God.',
  reference: 'Psalm 46:10',
}

function todayString() {
  return new Date().toDateString()
}

// Direct bible-api fallback (legacy path). Same selection algorithm
// as the server's so a force-refresh-while-offline doesn't surface
// a wildly different verse than what's normally on the page.
async function fetchFromBibleApi({ force }) {
  const d = new Date()
  const seed = force
    ? Math.floor(Math.random() * 100000)
    : (d.getFullYear() * 10000) + (d.getMonth() * 100) + d.getDate()
  const book    = FALLBACK_BOOKS[seed % FALLBACK_BOOKS.length]
  const chapter = (seed % 10) + 1
  const verseN  = (seed % 20) + 1
  const query   = `${book} ${chapter}:${verseN}`

  const res = await fetch(`https://bible-api.com/${encodeURIComponent(query)}`)
  if (!res.ok) throw new Error(`bible-api responded ${res.status}`)
  const data = await res.json()
  if (!data.text) throw new Error('bible-api returned no text')
  return {
    text:      data.text.trim(),
    reference: data.reference,
  }
}

export const getDailyVerse = async ({ force = false } = {}) => {
  const today = todayString()

  // Hit the localStorage cache first for instant render — only when
  // not forcing a refresh.
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY))
      if (cached && cached.date === today) return cached.verse
    } catch { /* corrupt entry — fall through and refetch */ }
  }

  // Server-first. The server caches today's verse in-process, so the
  // whole org (and eventually multiple orgs) hit bible-api.com once
  // per server instance per day rather than once per user per load.
  try {
    const url = force ? '/api/daily-verse?random=true' : '/api/daily-verse'
    const res = await fetch(apiUrl(url))
    if (res.ok) {
      const verseData = await res.json()
      if (!force) {
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ date: today, verse: verseData }))
        } catch { /* localStorage may be full or disabled — degrade silently */ }
      }
      return verseData
    }
  } catch { /* server unreachable — try the bible-api fallback below */ }

  // Server failed — try direct bible-api as a fallback so offline /
  // disconnected dev still shows something other than an error.
  try {
    const verseData = await fetchFromBibleApi({ force })
    if (!force) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ date: today, verse: verseData }))
      } catch { /* see above */ }
    }
    return verseData
  } catch {
    return FALLBACK_VERSE
  }
}
