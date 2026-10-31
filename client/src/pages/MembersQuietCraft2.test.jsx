// Quiet craft 2: Members has no Growth-% tile. José accepted Leo's call
// (2026-10-28) after Jarvis's review — animated metrics and growth-% conflict
// with "nothing here counts".

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Clients from './Clients'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (b) => ({ ok: true, status: 200, json: async () => b })
const SAMPLE = { id: 7, name: 'Sample Member', role: 'Member', status: 'active', created_at: '2026-01-01', updated_at: '2026-01-02' }

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/clients/stats')) return ok({ total: 2, newWeek: 1, active: 2, growth: 100 })
    if (u.includes('/api/clients')) return ok([SAMPLE])
    return ok({})
  }))
})

describe('Members quiet craft 2', () => {
  it('does not show a Growth tile even when the API returns +100%', async () => {
    render(
      <MemoryRouter>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>
              <Clients />
            </ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </MemoryRouter>
    )
    expect(await screen.findByText('Sample Member')).toBeInTheDocument()
    const stats = screen.getByTestId('member-stats')
    expect(stats).not.toHaveTextContent(STRINGS.en['mem.growth'])
    expect(stats).not.toHaveTextContent('+100%')
    expect(stats).not.toHaveTextContent('100%')
    expect(stats).toHaveTextContent('2')
  })
})
