// Golden Journey 2 — Find a member → linked sacramental record →
// certificate print (OC-GOLDEN-JOURNEY-2 Part B).
//
// Extends the existing "St Test" / Maria-shaped register fixtures used by
// MemberSacraments.test.jsx, SacramentCertificateReturn.test.jsx, and
// PrintSurfacesHonesty.test.jsx. Synthetic names only — no real parish,
// member, donor, child, or sacramental data.
//
// Product path on origin/main (GOLDEN-JOURNEY-2 @ 502b573):
//   /clients → slide-over → /clients/:id →
//   /register/:id/certificate?from=member → window.print()
// No server PDF, email, or Share API. REG.1 observe only.
//
// Verify:
//   cd client && npm test -- src/pages/GoldenJourney2.test.jsx
// Both journeys (GJ1 + GJ2; fixtures stay split):
//   cd client && npm run test:golden

export const GJ2_PARISH = { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' }

export const GJ2_AUTH_USER = {
  id: 1,
  name: 'Secretary',
  role: 'admin',
  organization: GJ2_PARISH,
}

// Frozen Sunday so the paper issue line is deterministic (print marker,
// not a send). Matches the GJ1 "freeze Date" pattern.
export const GJ2_NOW = new Date(2026, 8, 20, 15, 0, 0)

export const GJ2_MEMBER_ID = 22002
export const GJ2_RECORD_ID = 22021
export const GJ2_VOIDED_ID = 22022
export const GJ2_UNKNOWN_ID = 22023
export const GJ2_MISSING_ID = 22024
export const GJ2_FAIL_ID = 22025
export const GJ2_OTHER_ID = 22003

// Live roster name after a rename. The certificate must keep the
// stored register name. A missing snapshot is not filled from the roster.
export const GJ2_LIVE_NAME = 'Sample Member Rivera'
export const GJ2_SNAPSHOT_NAME = 'Sample Baptismal Member'
export const GJ2_OTHER_NAME = 'Other Sample Member'
export const GJ2_CERT_NO = 'GJ2-001'
export const GJ2_MINISTER = 'Fr. Sample Wright'
export const GJ2_PLACE = 'St Test'
export const GJ2_DATE = '2018-06-10'
export const GJ2_GODPARENTS = ['Sample Godparent One', 'Sample Godparent Two']

export const GJ2_MEMBER = {
  id: GJ2_MEMBER_ID,
  name: GJ2_LIVE_NAME,
  email: 'sample.member@example.test',
  status: 'active',
  role: 'Member',
  created_at: '2018-01-15T12:00:00Z',
  updated_at: '2026-09-01T12:00:00Z',
}

export const GJ2_OTHER = {
  id: GJ2_OTHER_ID,
  name: GJ2_OTHER_NAME,
  email: 'other.sample@example.test',
  status: 'active',
  role: 'Member',
  created_at: '2019-03-01T12:00:00Z',
  updated_at: '2026-09-01T12:00:00Z',
}

export const GJ2_RECORD = {
  id: GJ2_RECORD_ID,
  type: 'baptism',
  member_name: GJ2_SNAPSHOT_NAME,
  client_id: GJ2_MEMBER_ID,
  date: GJ2_DATE,
  place: GJ2_PLACE,
  minister: GJ2_MINISTER,
  certificate_no: GJ2_CERT_NO,
  notes: null,
  meta_attributes: { godparents: GJ2_GODPARENTS },
  voided_at: null,
}

export const GJ2_VOIDED = {
  ...GJ2_RECORD,
  id: GJ2_VOIDED_ID,
  voided_at: '2026-08-01T00:00:00Z',
  voided_reason: 'Entered twice in the sample book',
}

export const GJ2_UNKNOWN = {
  ...GJ2_RECORD,
  id: GJ2_UNKNOWN_ID,
  type: 'custom_rite',
}

export const GJ2_DELETE_405 = {
  error: 'Register entries are never deleted. Void the entry instead — it stays in the record, marked void, with your reason.',
  void_endpoint: `/api/sacraments/${GJ2_RECORD_ID}/void`,
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const fail = (status, body) => ({ ok: false, status, json: async () => body })

function clientIdFrom(url) {
  const m = String(url).match(/\/api\/clients\/(\d+)(?:\b|$)/)
  return m ? Number(m[1]) : null
}

function sacramentIdFrom(url) {
  const m = String(url).match(/\/api\/sacraments\/(\d+)(?:\b|$)/)
  return m ? Number(m[1]) : null
}

function queryClientId(url) {
  const u = String(url)
  const q = u.includes('?') ? u.slice(u.indexOf('?')) : ''
  const id = Number(new URLSearchParams(q).get('client_id'))
  return Number.isInteger(id) && id > 0 ? id : null
}

// List is an array (GET /api/clients). Profile and register reads are
// objects. Voided rows are not on the member timeline — they exist only
// when asked for by id, same as the working register.
export function stubGoldenJourney2Fetch(vi) {
  return vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    const method = (opts.method || 'GET').toUpperCase()

    if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
    if (u.includes('/api/pledges')) return ok({ pledges: [] })
    if (u.includes('/api/availability')) return ok({ unavailability: [] })
    if (u.includes('/api/calendar-sync')) return ok({})

    if (method === 'DELETE' && u.includes(`/api/sacraments/${GJ2_RECORD_ID}`)) {
      return fail(405, GJ2_DELETE_405)
    }

    const sacramentId = sacramentIdFrom(u)
    if (sacramentId === GJ2_RECORD_ID && !u.includes('?')) return ok(GJ2_RECORD)
    if (sacramentId === GJ2_VOIDED_ID && !u.includes('?')) return ok(GJ2_VOIDED)
    if (sacramentId === GJ2_UNKNOWN_ID && !u.includes('?')) return ok(GJ2_UNKNOWN)
    if (sacramentId === GJ2_MISSING_ID && !u.includes('?')) return fail(404, { error: 'not found' })
    if (sacramentId === GJ2_FAIL_ID && !u.includes('?')) return fail(503, { error: 'upstream' })

    const scoped = queryClientId(u)
    if (u.includes('/api/sacraments?')) {
      if (scoped === GJ2_MEMBER_ID) return ok({ records: [GJ2_RECORD] })
      return ok({ records: [] })
    }

    if (u.includes('/api/clients/stats')) {
      return ok({ total: 2, newWeek: 0, active: 2, growth: 0 })
    }
    if (u.includes('/donations')) return ok({ lines: [], total: 0, gift_count: 0 })
    if (u.includes('/checkins')) return ok({ checkins: [], count: 0 })

    const memberId = clientIdFrom(u)
    if (memberId === GJ2_MEMBER_ID) return ok(GJ2_MEMBER)
    if (memberId === GJ2_OTHER_ID) return ok(GJ2_OTHER)

    if (u.includes('/api/clients?') || /\/api\/clients\/?$/.test(u)) {
      return ok([GJ2_MEMBER, GJ2_OTHER])
    }

    return ok({})
  }))
}
