// traditionFor(orgId) — the org's tradition, cached.
//
// Every liturgical read would otherwise add a round-trip to
// ochr_organizations for a value that changes roughly never. A tiny TTL
// cache keeps the hot paths (calendar stamping, the packet, the daily
// liturgical widget) at one query per org per minute.
//
// The TTL is short on purpose. This is not a correctness mechanism — it
// is a politeness to the database. An admin who changes their tradition
// should see it take effect while they are still looking at the screen,
// so 60s rather than "until the process restarts".

import pool from '../db.js'
import { DEFAULT_TRADITION } from './index.js'

const TTL_MS = 60_000
const cache = new Map()   // orgId → { value, expires }

export async function traditionFor(orgId) {
  if (!orgId) return DEFAULT_TRADITION
  const hit = cache.get(orgId)
  if (hit && hit.expires > Date.now()) return hit.value

  try {
    const { rows } = await pool.query(
      'SELECT tradition FROM ochr_organizations WHERE id = $1',
      [orgId]
    )
    const value = rows[0]?.tradition || DEFAULT_TRADITION
    cache.set(orgId, { value, expires: Date.now() + TTL_MS })
    return value
  } catch {
    // A tradition lookup must never be the reason a calendar fails to
    // load. Falling back to 'general' loses a Sunday designation; it does
    // not lose the page — and 'general' is the one value that cannot be
    // wrong in another tradition's vocabulary.
    return DEFAULT_TRADITION
  }
}

// Called after an org's tradition changes so the admin sees it at once.
export function invalidateTradition(orgId) {
  cache.delete(orgId)
}

// Tests run many orgs through one process.
export function _clearTraditionCache() {
  cache.clear()
}
