// A refused read of the service plans used to become `{ plans: [] }`,
// and the rail then said "No service plans yet." A refused read of the
// plan that was just selected said "No plan selected."

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import ServicePlanner from './ServicePlanner'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Sacristan', role: 'admin' },
    loading: false,
    canWrite: true,
  }),
}))

vi.mock('../components/ToastProvider', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {} }),
}))

vi.mock('../components/ConfirmProvider', () => ({
  useConfirm: () => async () => false,
}))

const PLAN = { id: 7, date: '2026-10-04', title: 'Sunday Mass', element_count: 2 }
const DETAIL = { ...PLAN, elements: [{ id: 1, kind: 'reading', title: 'Gospel', reference: 'John 1' }] }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) })

function stub({ plans = ok({ plans: [] }), detail = ok(DETAIL), locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (/\/api\/service-plans\/\d+/.test(u)) return detail
    if (u.includes('/api/service-plans')) return plans
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/organization')) return ok({ name: 'St Test' })
    if (u.includes('/api/liturgical')) return ok({ season: null, feast_name: null, color: null })
    return ok(null)
  }))
}

function mount() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ServicePlanner />
      </LocaleProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('service plans when the list did not load', () => {
  it('does not call a refused list an empty order of worship', async () => {
    const en = STRINGS.en
    stub({ plans: refused() })
    mount()
    expect((await screen.findAllByText(en['plan.unread'])).length).toBeGreaterThan(0)
    expect(screen.queryByText(en['plan.none'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['plan.noneSelected'])).not.toBeInTheDocument()
  })

  it('still says when the parish truly has no plan', async () => {
    const en = STRINGS.en
    stub({ plans: ok({ plans: [] }) })
    mount()
    expect(await screen.findByText(en['plan.none'])).toBeInTheDocument()
    expect(screen.getByText(en['plan.noneSelected'])).toBeInTheDocument()
    expect(screen.queryByText(en['plan.unread'])).not.toBeInTheDocument()
  })

  it('does not call a refused plan an empty selection', async () => {
    const en = STRINGS.en
    stub({ plans: ok({ plans: [PLAN] }), detail: refused() })
    mount()
    expect(await screen.findByRole('button', { name: /Sunday Mass/ })).toBeInTheDocument()
    expect(await screen.findByText(en['plan.detailUnread'])).toBeInTheDocument()
    expect(screen.queryByText(en['plan.noneSelected'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['plan.none'])).not.toBeInTheDocument()
  })

  it('shows the plan that came back', async () => {
    stub({ plans: ok({ plans: [PLAN] }) })
    mount()
    expect(await screen.findByText('Gospel')).toBeInTheDocument()
  })

  it('says the same thing in Spanish when the list did not load', async () => {
    const es = STRINGS.es
    stub({ plans: refused(), locale: 'es' })
    mount()
    expect((await screen.findAllByText(es['plan.unread'])).length).toBeGreaterThan(0)
    expect(screen.queryByText(es['plan.none'])).not.toBeInTheDocument()
  })

  it('does not treat a body that is not a list as an empty parish', async () => {
    const en = STRINGS.en
    stub({ plans: ok({ plans: null }) })
    mount()
    expect((await screen.findAllByText(en['plan.unread'])).length).toBeGreaterThan(0)
    expect(screen.queryByText(en['plan.none'])).not.toBeInTheDocument()
  })
})
