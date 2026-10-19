// SP-021: a Viewer's pages only ask for what the server lets a Viewer read,
// the sidebar and routes match, and Help's role table says the same.
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { viewerMayRead } from '../../../server/src/middleware/viewerScope.js'
import { viewerMayOpen } from '../auth/viewerPages'
import { ROLE_TABLE, MODULE_HELP, FAQ } from '../data/helpContent'
import Dashboard from './Dashboard'
import MemberDetail from './MemberDetail'
import Schedule from './Schedule'
import { Sidebar } from '../App'
import { ThemeProvider } from '../context/ThemeContext'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 9, name: 'Vera Viewer', role: 'viewer', organization: { id: 1, name: 'St Test', locale: 'en' } },
    loading: false,
    canWrite: false,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
let asked = []
function stub() {
  asked = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = new URL(String(url), 'http://x').pathname
    const method = (init?.method || 'GET').toUpperCase()
    if (method === 'GET') asked.push(u)
    if (method === 'GET' && !viewerMayRead(u)) return { ok: false, status: 403, json: async () => ({ error: 'viewer_scope' }) }
    if (u === '/api/clients/stats') return ok({ total: 3, active: 3, newWeek: 0 })
    if (/^\/api\/clients\/\d+$/.test(u)) return ok({ id: 7, name: 'Ana Member', status: 'active' })
    if (/^\/api\/clients\/\d+\/checkins$/.test(u)) return ok({ checkins: [] })
    if (u === '/api/clients' || u === '/api/schedule' || u === '/api/calendar') return ok([])
    if (u.startsWith('/api/liturgical')) return ok(null)
    return ok({})
  }))
}

function wrap(ui, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider><ToastProvider><ConfirmProvider>
        {ui}
      </ConfirmProvider></ToastProvider></LocaleProvider>
    </MemoryRouter>
  )
}

const refused = () => asked.filter(u => !viewerMayRead(u))

beforeEach(() => { vi.unstubAllGlobals(); localStorage.clear(); stub() })

describe('SP-021 Viewer pages ask only for what a Viewer may read', () => {
  it('Dashboard', async () => {
    wrap(<Dashboard />)
    await waitFor(() => expect(asked).toContain('/api/clients/stats'))
    await new Promise(r => setTimeout(r, 50))
    expect(refused()).toEqual([])
    expect(screen.queryByText(/didn't load/i)).toBeNull()
    expect(screen.queryByText(/Clear sample data/i)).toBeNull()
  })
  it('Member profile', async () => {
    wrap(<Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>, '/clients/7')
    expect(await screen.findAllByText('Ana Member')).not.toHaveLength(0)
    await new Promise(r => setTimeout(r, 50))
    expect(refused()).toEqual([])
  })
  it('Schedule', async () => {
    wrap(<Schedule />, '/schedule')
    await waitFor(() => expect(asked.some(u => u.startsWith('/api/calendar'))).toBe(true))
    await new Promise(r => setTimeout(r, 50))
    expect(refused()).toEqual([])
  })
})

describe('SP-029 Viewer shell makes no call that can only 403', () => {
  it('Sidebar skips /api/affiliation for a Viewer', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    wrap(<ThemeProvider><Sidebar /></ThemeProvider>)
    await new Promise(r => setTimeout(r, 50))
    expect(asked).not.toContain('/api/affiliation')
    expect(refused()).toEqual([])
  })
  it('Schedule header has no Sunday Packet link for a Viewer', async () => {
    wrap(<Schedule />, '/schedule')
    await waitFor(() => expect(asked.some(u => u.startsWith('/api/calendar'))).toBe(true))
    expect(document.querySelector('a[href^="/packet"]')).toBeNull()
  })
})

describe('SP-021 Viewer routes', () => {
  it.each(['/', '/clients', '/clients/12', '/schedule', '/preferences', '/getting-settled'])('%s opens', (p) => {
    expect(viewerMayOpen(p)).toBe(true)
  })
  it.each(['/donations', '/payroll', '/finance', '/billing', '/groups', '/migration', '/schedule/conflicts',
    '/checkin', '/register', '/mass-intentions', '/events', '/tasks', '/offerings', '/archive', '/library', '/ai', '/packet'])
  ('%s shows the Viewer notice', (p) => {
    expect(viewerMayOpen(p)).toBe(false)
  })
})

describe('SP-021 Help says what the server does', () => {
  it('the Viewer column is true only for Dashboard/Schedule/Members and Report a problem', () => {
    const yes = ROLE_TABLE.filter(r => r.viewer).map(r => r.area)
    expect(yes).toEqual(['Dashboard, Schedule, Members (view)', 'Report a problem; use the Assistant'])
  })
  it('Team guide and FAQ no longer promise Viewers read everything', () => {
    const all = JSON.stringify(MODULE_HELP.team) + JSON.stringify(FAQ)
    expect(all).not.toMatch(/Read-only everywhere/)
    expect(all).not.toMatch(/read everything they/)
    expect(all).toMatch(/Viewers see the Dashboard, Members and Schedule/)
  })
})
