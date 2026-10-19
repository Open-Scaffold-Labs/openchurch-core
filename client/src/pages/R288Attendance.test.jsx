// R288-2: a member's attendance panel is not fetched or shown for a Viewer;
// Staff and Admin keep it (positive controls).
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MemberDetail from './MemberDetail'

let role = 'viewer'
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 9, name: 'Test User', role, organization: { id: 1, name: 'St Test', locale: 'en' } },
    loading: false,
    canWrite: role !== 'viewer',
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
let asked = []
beforeEach(() => {
  vi.unstubAllGlobals(); localStorage.clear(); asked = []
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = new URL(String(url), 'http://x').pathname
    asked.push(u)
    if (/^\/api\/clients\/\d+$/.test(u)) return ok({ id: 7, name: 'Ana Member', status: 'active' })
    if (/^\/api\/clients\/\d+\/checkins$/.test(u)) return ok({ checkins: [{ id: 1, event_title: 'Sunday Mass', checked_in_at: '2026-10-11T17:00:00Z' }] })
    if (/\/donations$/.test(u)) return ok([])
    return ok({})
  }))
})

const show = () => render(
  <MemoryRouter initialEntries={['/clients/7']}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>)

describe('R288-2 member attendance', () => {
  it('Viewer: no /checkins fetch and no Attendance panel', async () => {
    role = 'viewer'
    show()
    expect(await screen.findAllByText('Ana Member')).not.toHaveLength(0)
    await new Promise(r => setTimeout(r, 80))
    expect(asked.some(u => u.endsWith('/checkins'))).toBe(false)
    expect(screen.queryByRole('heading', { name: /^attendance$/i })).toBeNull()
  })
  it.each(['staff', 'admin'])('%s: fetches /checkins and shows the panel', async (r) => {
    role = r
    show()
    expect(await screen.findAllByText('Ana Member')).not.toHaveLength(0)
    expect(await screen.findByRole('heading', { name: /^attendance$/i })).toBeTruthy()
    expect(asked.some(u => u.endsWith('/checkins'))).toBe(true)
  })
})
