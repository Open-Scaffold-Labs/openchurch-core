import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// ── Easter calculation (Anonymous Gregorian algorithm) ────────
// Exported: services/lectionary.js anchors the RCL Sunday designations
// on the same computus, so the two can never disagree about Easter.
export function computeEaster(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month, day))
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000)
}

// Advent starts on the Sunday nearest to Nov 30
export function adventStart(year) {
  const nov30 = new Date(Date.UTC(year, 10, 30))
  const dow = nov30.getUTCDay()
  return dow <= 3 ? addDays(nov30, -dow) : addDays(nov30, 7 - dow)
}

function fmt(d) { return d.toISOString().slice(0, 10) }

// Pure-compute liturgical context for any YYYY-MM-DD. Exported so
// other routes (events.js auto-maps liturgical context onto new
// events at create time) can reuse it without re-implementing the
// Easter algorithm. DB overrides are NOT consulted here — callers
// that want override-aware lookup should query
// ochr_liturgical_calendar first and fall back to this.
export function getLiturgicalInfo(dateStr) {
  const date = new Date(dateStr + 'T00:00:00Z')
  const y    = date.getUTCFullYear()
  const mm   = date.getUTCMonth()   // 0-indexed
  const dd   = date.getUTCDate()

  const easter    = computeEaster(y)
  const ashWed    = addDays(easter, -46)
  const palmSun   = addDays(easter, -7)
  const holyThur  = addDays(easter, -3)
  const goodFri   = addDays(easter, -2)
  const ascension = addDays(easter, 39)
  const pentecost = addDays(easter, 49)
  const advent    = adventStart(y)
  const christmas = new Date(Date.UTC(y, 11, 25))

  const d = dateStr // ISO string comparisons work on YYYY-MM-DD

  // Christmas season carry-over (Jan 1–5)
  if (mm === 0 && dd < 6)
    return { season: 'Christmas', color: 'White', feast_name: dd === 1 ? 'Mary, Mother of God' : null }
  // Epiphany
  if (mm === 0 && dd === 6)
    return { season: 'Christmas', color: 'White', feast_name: 'Epiphany' }
  // Ordinary Time (post-Epiphany)
  if (d < fmt(ashWed))
    return { season: 'Ordinary Time', color: 'Green', feast_name: null, ordinary_block: 'after_epiphany' }
  // Ash Wednesday
  if (d === fmt(ashWed))
    return { season: 'Lent', color: 'Purple', feast_name: 'Ash Wednesday' }
  // Lent
  if (d < fmt(palmSun))
    return { season: 'Lent', color: 'Purple', feast_name: null }
  // Palm Sunday
  if (d === fmt(palmSun))
    return { season: 'Holy Week', color: 'Red', feast_name: 'Palm Sunday' }
  // Holy Monday–Wednesday
  if (d < fmt(holyThur))
    return { season: 'Holy Week', color: 'Purple', feast_name: null }
  // Holy Thursday
  if (d === fmt(holyThur))
    return { season: 'Holy Week', color: 'White', feast_name: 'Holy Thursday' }
  // Good Friday
  if (d === fmt(goodFri))
    return { season: 'Holy Week', color: 'Red', feast_name: 'Good Friday' }
  // Holy Saturday
  if (d < fmt(easter))
    return { season: 'Holy Week', color: 'Purple', feast_name: 'Holy Saturday' }
  // Easter Sunday
  if (d === fmt(easter))
    return { season: 'Easter', color: 'White', feast_name: 'Easter Sunday' }
  // Ascension
  if (d === fmt(ascension))
    return { season: 'Easter', color: 'White', feast_name: 'Ascension' }
  // Easter season
  if (d < fmt(pentecost))
    return { season: 'Easter', color: 'White', feast_name: null }
  // Pentecost
  if (d === fmt(pentecost))
    return { season: 'Pentecost', color: 'Red', feast_name: 'Pentecost' }
  // Ordinary Time (post-Pentecost)
  if (d < fmt(advent)) {
    const ob = 'after_pentecost'
    if (mm === 7 && dd === 15)  return { season: 'Ordinary Time', color: 'White',  feast_name: 'Assumption', ordinary_block: ob }
    if (mm === 10 && dd === 1)  return { season: 'Ordinary Time', color: 'White',  feast_name: 'All Saints', ordinary_block: ob }
    if (mm === 10 && dd === 2)  return { season: 'Ordinary Time', color: 'Purple', feast_name: 'All Souls', ordinary_block: ob }
    return { season: 'Ordinary Time', color: 'Green', feast_name: null, ordinary_block: ob }
  }
  // Advent
  if (d < fmt(christmas))
    return { season: 'Advent', color: 'Purple', feast_name: null }
  // Christmas
  return {
    season: 'Christmas', color: 'White',
    feast_name: dd === 25 ? 'Christmas' : dd === 26 ? 'St. Stephen' : null,
  }
}

// `ordinary_block` (TRAD.1) rides alongside the canonical season token:
// 'after_epiphany' | 'after_pentecost' | null. Roman and Lutheran practice
// call both blocks "Ordinary Time"; Episcopal and Anglican practice call
// them "Season after the Epiphany" and "Season after Pentecost". The token
// is the season's identity and is stored on calendar rows; the block is
// what lets a tradition supply the right word for it without a data
// migration.

// Overlay a parish-specific feast (LIT.5) onto a resolved base context.
// A parish feast names the day and may recolor it, but keeps the
// computed/global SEASON — a patronal feast in July is still Ordinary
// Time, just with a name and (usually) white. Pass `base` and the row
// from ochr_parish_feasts (or undefined). Returns base unchanged when
// there's no parish feast.
function applyParishFeast(base, feast) {
  if (!feast) return base
  return {
    season:         base.season,
    color:          feast.liturgical_color || base.color,
    feast_name:     feast.feast_name,
    ordinary_block: base.ordinary_block ?? null,
  }
}

// Override-aware liturgical lookup for a YYYY-MM-DD string. Precedence:
// parish feast (org-scoped, LIT.5) → global ochr_liturgical_calendar
// override → pure-compute getLiturgicalInfo(). Shared so routes/
// calendar.js can stamp season/color/feast onto events at create/update
// time without re-implementing the precedence. A DB hiccup degrades to
// the computed answer rather than failing the write. Pass `orgId` to
// layer that org's parish feasts; omit it for the universal calendar.
export async function resolveLiturgicalContext(dateStr, orgId = null) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { season: null, color: null, feast_name: null, ordinary_block: null }
  }
  let base = getLiturgicalInfo(dateStr)
  try {
    const { rows } = await pool.query(
      'SELECT season, liturgical_color AS color, feast_name FROM ochr_liturgical_calendar WHERE date = $1',
      [dateStr]
    )
    // A hand-seeded global override row has no ordinary_block; keep the
    // computed one so an override that renames a day cannot also silently
    // drop the block an Episcopal parish needs to name its season.
    if (rows.length) base = { ...rows[0], ordinary_block: base.ordinary_block ?? null }
  } catch (err) {
    monitor.error('liturgical.override', err, { date: dateStr })
  }
  if (orgId) {
    try {
      const { rows } = await pool.query(
        'SELECT feast_name, liturgical_color FROM ochr_parish_feasts WHERE organization_id = $1 AND date = $2',
        [orgId, dateStr]
      )
      if (rows.length) base = applyParishFeast(base, rows[0])
    } catch (err) {
      monitor.error('liturgical.parishFeast', err, { date: dateStr, orgId })
    }
  }
  // Normalised so a consumer never reads `undefined` off one branch and a
  // value off another — seasons outside counted time simply have no block.
  return { ...base, ordinary_block: base.ordinary_block ?? null }
}

// Batched override-aware lookup. One SELECT for the global overrides and
// (when orgId is given) one for the parish feasts, with computed fallback
// merged in. Use this on hot paths that compute N dates at once (e.g. a
// recurring series with up to 26 occurrences) to avoid N+1 round-trips
// through the Supabase pooler. Precedence matches resolveLiturgicalContext:
// parish feast → global override → computed.
export async function resolveLiturgicalBatch(dateStrs, orgId = null) {
  const valid = (dateStrs || []).filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
  const out = new Map()
  const overrides = new Map()
  const feasts = new Map()
  if (valid.length) {
    try {
      const { rows } = await pool.query(
        'SELECT to_char(date, \'YYYY-MM-DD\') AS date, season, liturgical_color AS color, feast_name FROM ochr_liturgical_calendar WHERE date = ANY($1::date[])',
        [valid]
      )
      for (const r of rows) overrides.set(r.date, { season: r.season, color: r.color, feast_name: r.feast_name })
    } catch (err) {
      monitor.error('liturgical.overrideBatch', err, { count: valid.length })
    }
    if (orgId) {
      try {
        const { rows } = await pool.query(
          'SELECT to_char(date, \'YYYY-MM-DD\') AS date, feast_name, liturgical_color FROM ochr_parish_feasts WHERE organization_id = $1 AND date = ANY($2::date[])',
          [orgId, valid]
        )
        for (const r of rows) feasts.set(r.date, r)
      } catch (err) {
        monitor.error('liturgical.parishFeastBatch', err, { orgId, count: valid.length })
      }
    }
  }
  for (const d of valid) {
    const base = overrides.get(d) ?? getLiturgicalInfo(d)
    out.set(d, applyParishFeast(base, feasts.get(d)))
  }
  return out
}

// GET /api/liturgical?date=YYYY-MM-DD
router.get('/', async (req, res) => {
  const { date } = req.query
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' })

  try {
    // Parish feast → global override → computed, scoped to the caller's
    // org so a patronal feast surfaces only for that church (LIT.5).
    const info = await resolveLiturgicalContext(date, req.organizationId)
    // 1-hour private cache. The liturgical calendar for any given date
    // is effectively immutable — Easter, Advent, etc. don't shift
    // within a session. Admin-defined feast overrides could change
    // the answer, but those are rare enough that a 1h staleness
    // window is acceptable; admins can hard-refresh if they just
    // changed an override and want it to surface.
    res.set('Cache-Control', 'private, max-age=3600')
    res.json(info)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to compute liturgical info' })
  }
})

// GET /api/liturgical/range?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/range', async (req, res) => {
  const { start, end } = req.query
  if (!start || !end) return res.status(400).json({ error: 'start and end required' })
  try {
    // Build the date list, then resolve in one batched pass that layers
    // parish feasts (LIT.5) over the global overrides and computed base.
    const dates = []
    const s = new Date(start + 'T00:00:00Z')
    const e = new Date(end + 'T00:00:00Z')
    for (let d = new Date(s); d <= e; d = addDays(d, 1)) dates.push(fmt(d))

    const resolved = await resolveLiturgicalBatch(dates, req.organizationId)
    const results = {}
    for (const ds of dates) results[ds] = resolved.get(ds) ?? getLiturgicalInfo(ds)

    // Same 1-hour private cache as the single-date endpoint — the
    // grid view fires this per-week and the data is effectively
    // immutable session-to-session. Admin-defined feast overrides
    // tolerate the same 1h staleness window with a hard-refresh
    // escape hatch.
    res.set('Cache-Control', 'private, max-age=3600')
    res.json(results)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to compute range' })
  }
})

// NOTE: there is deliberately no POST here. Per-parish overrides live in
// the org-scoped, admin-gated /api/parish-feasts route; the global
// ochr_liturgical_calendar table is computed-fallback data seeded
// out-of-band, not user-writable. The former POST '/' let any authed user
// write a cross-tenant row into that global table — removed as a tenancy
// leak.

export default router
