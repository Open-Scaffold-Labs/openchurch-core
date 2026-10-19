// Golden Journey 1 — Mass Intention → Sacristy List → print
// (OC-EXPERIENCE-OS-001 Part C).
//
// Extends the existing "St Test" sheet already used by
// SacristySheet.test.jsx and SacristyPrintHonesty.test.jsx. Synthetic
// names only — no real parish, member, donor, or sacramental data.
//
// Verify:
//   cd client && npm test -- src/pages/GoldenJourney1.test.jsx
// Both journeys (GJ1 + GJ2; fixtures stay split):
//   cd client && npm run test:golden

// catholic is absent from TRADITION_STRINGS, so t() uses the shared
// strings.js table the Golden Journey 1 spec cites (Mass Intentions).
export const GJ1_PARISH = { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic', timezone: 'UTC' }

export const GJ1_AUTH_USER = {
  id: 1,
  name: 'Secretary',
  role: 'admin',
  organization: GJ1_PARISH,
}

// Wednesday 2026-09-16 15:00 UTC. Missing `start` opens the coming
// Sunday's vigil week: Saturday 2026-09-19 through Friday 2026-09-25.
// The instant is absolute so the parish zone, not the host clock, names the day.
export const GJ1_NOW = new Date('2026-09-16T15:00:00.000Z')
export const GJ1_WEEK_START = '2026-09-19'
export const GJ1_WEEK_END = '2026-09-25'

export const GJ1_IN_WINDOW = {
  id: 21,
  mass_date: '2026-09-20',
  status: 'scheduled',
  intention: '+ For the repose of Sample Parishioner',
  formatted_intention: '+ For the repose of Sample Parishioner',
  requested_by: 'Sample requester',
  requester_name: null,
  stipend: 10,
  mass_title: 'Daily Mass',
  mass_time: '09:00:00',
}

export const GJ1_OUTSIDE = {
  id: 13,
  mass_date: '2026-08-02',
  status: 'scheduled',
  intention: 'OUT-OF-WINDOW SAMPLE',
  formatted_intention: 'OUT-OF-WINDOW SAMPLE',
  requested_by: 'Outside requester',
  requester_name: null,
  stipend: null,
  mass_title: null,
  mass_time: null,
}

export const GJ1_DISPLAY_INTENTION = '† For the repose of Sample Parishioner'

export function queryStart(url) {
  const u = String(url)
  const q = u.includes('?') ? u.slice(u.indexOf('?')) : ''
  return new URLSearchParams(q).get('start')
}

export function queryEnd(url) {
  const u = String(url)
  const q = u.includes('?') ? u.slice(u.indexOf('?')) : ''
  return new URLSearchParams(q).get('end')
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

// Book lists every intention; weekly returns only the vigil week.
// nearest-outside is unused on the happy path (week is not empty).
export function stubGoldenJourney1Fetch(vi) {
  return vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
    if (u.includes('/api/mass-intentions/nearest-outside')) {
      return ok({ date: GJ1_OUTSIDE.mass_date, undated_waiting: false, undated_waiting_count: 0 })
    }
    if (u.includes('/api/mass-intentions/weekly')) {
      const start = queryStart(u)
      const end = queryEnd(u)
      const inWeek = start === GJ1_WEEK_START && end === GJ1_WEEK_END
      return ok({ intentions: inWeek ? [GJ1_IN_WINDOW] : [] })
    }
    if (u.includes('/api/mass-intentions')) return ok({ intentions: [GJ1_IN_WINDOW, GJ1_OUTSIDE] })
    return ok({})
  }))
}
