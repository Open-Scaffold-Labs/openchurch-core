// A refused parish read used to become {}, so a printed order left the
// name blank. A refused liturgical day used to become null, so the plan
// looked like a service with no feast or season.

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import ServicePlanner from './ServicePlanner'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Sacristan', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
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

const PLAN = { id: 7, date: '2026-10-04', title: 'Sunday Mass', element_count: 1 }
const DETAIL = { ...PLAN, elements: [{ id: 1, kind: 'reading', title: 'Gospel', reference: 'John 1' }] }
const QUIET_DAY = { season: null, feast_name: null, color: null }
const PALM = { season: 'lent', feast_name: 'Palm Sunday', color: 'Red' }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) })

function stub({
  org = ok({ name: 'St Test' }),
  liturgical = ok(QUIET_DAY),
  locale,
} = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (/\/api\/service-plans\/\d+/.test(u)) return ok(DETAIL)
    if (u.includes('/api/service-plans')) return ok({ plans: [PLAN] })
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/organization')) return org
    if (u.includes('/api/liturgical')) return liturgical
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

describe('the parish name and the liturgical day on a service plan', () => {
  it('does not leave a refused parish name looking loaded', async () => {
    const en = STRINGS.en
    stub({ org: refused() })
    mount()
    expect(await screen.findByText(en['plan.orgUnread'])).toBeInTheDocument()
    expect(await screen.findByText('Sunday Mass')).toBeInTheDocument()
  })

  it('does not treat a parish body with no name as loaded', async () => {
    const en = STRINGS.en
    stub({ org: ok({}) })
    mount()
    expect(await screen.findByText(en['plan.orgUnread'])).toBeInTheDocument()
  })

  it('stays quiet when the parish name did load', async () => {
    const en = STRINGS.en
    stub()
    mount()
    expect(await screen.findByText('Sunday Mass')).toBeInTheDocument()
    expect(screen.queryByText(en['plan.orgUnread'])).not.toBeInTheDocument()
  })

  it('does not call a refused liturgical day a service with no feast', async () => {
    const en = STRINGS.en
    stub({ liturgical: refused() })
    mount()
    expect(await screen.findByText(en['plan.litUnread'])).toBeInTheDocument()
    expect(screen.queryByText('Palm Sunday')).not.toBeInTheDocument()
  })

  it('does not call a liturgical body that is not a day a quiet service', async () => {
    const en = STRINGS.en
    stub({ liturgical: ok(null) })
    mount()
    expect(await screen.findByText(en['plan.litUnread'])).toBeInTheDocument()
  })

  it('stays quiet when the day loaded and has no feast', async () => {
    const en = STRINGS.en
    stub({ liturgical: ok(QUIET_DAY) })
    mount()
    expect(await screen.findByText('Sunday Mass')).toBeInTheDocument()
    expect(screen.queryByText(en['plan.litUnread'])).not.toBeInTheDocument()
  })

  it('shows a feast that did load', async () => {
    const en = STRINGS.en
    stub({ liturgical: ok(PALM) })
    mount()
    expect(await screen.findByText('Palm Sunday')).toBeInTheDocument()
    expect(screen.queryByText(en['plan.litUnread'])).not.toBeInTheDocument()
  })

  it('says the refused day in Spanish', async () => {
    const es = STRINGS.es
    stub({ liturgical: refused(), locale: 'es' })
    mount()
    expect(await screen.findByText(es['plan.litUnread'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['plan.litUnread'])).not.toBeInTheDocument()
  })
})
