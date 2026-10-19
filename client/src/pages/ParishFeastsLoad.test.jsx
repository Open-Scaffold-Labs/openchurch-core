// A refused read of the parish's own feasts used to become
// `{ feasts: [] }`, and the card then said "No parish feasts yet."

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import OrgSettings from './OrgSettings'

const auth = vi.hoisted(() => ({ updateUser: vi.fn() }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Rector', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', timezone: 'UTC' } },
    updateUser: auth.updateUser,
    token: 't',
    loading: false,
  }),
}))

const ORG = {
  id: 1, name: 'St Test', slug: 'st-test', address: '', tax_id: '',
  signatory_name: '', signatory_title: '', statement_letterhead: '',
  tagline: '', about: '', service_times: '', page_published: false,
  reminder_lead_hours: 24, timezone: 'America/Los_Angeles', locale: 'en',
}

const FEAST = { id: 3, date: '2026-07-26', feast_name: 'St. Anne', liturgical_color: 'White' }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) })

function stub({ feasts = ok({ feasts: [] }), locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    if (u.endsWith('/api/organization') && method === 'GET') return ok(ORG)
    if (u.includes('/api/parish-feasts')) return feasts
    if (u.includes('/api/affiliation')) return ok({ affiliation: null })
    if (u.includes('/api/ai/provider')) return ok({ source: 'platform' })
    return ok({})
  }))
}

function mount() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <OrgSettings />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('parish feasts when the list did not load', () => {
  it('does not call a refused list a church with no feast of its own', async () => {
    const en = STRINGS.en
    stub({ feasts: refused() })
    mount()
    expect(await screen.findByText(en['feast.unread'])).toBeInTheDocument()
    expect(screen.queryByText('No parish feasts yet.')).not.toBeInTheDocument()
  })

  it('still says when the parish truly has none', async () => {
    const en = STRINGS.en
    stub({ feasts: ok({ feasts: [] }) })
    mount()
    expect(await screen.findByText('No parish feasts yet.')).toBeInTheDocument()
    expect(screen.queryByText(en['feast.unread'])).not.toBeInTheDocument()
  })

  it('shows a feast that came back', async () => {
    stub({ feasts: ok({ feasts: [FEAST] }) })
    mount()
    expect(await screen.findByText('St. Anne')).toBeInTheDocument()
    expect(screen.queryByText('No parish feasts yet.')).not.toBeInTheDocument()
  })

  it('does not treat a body that is not a list as an empty church', async () => {
    const en = STRINGS.en
    stub({ feasts: ok({ feasts: null }) })
    mount()
    expect(await screen.findByText(en['feast.unread'])).toBeInTheDocument()
    expect(screen.queryByText('No parish feasts yet.')).not.toBeInTheDocument()
  })

  it('says the same thing in Spanish when the list did not load', async () => {
    const es = STRINGS.es
    stub({ feasts: refused(), locale: 'es' })
    mount()
    expect(await screen.findByText(es['feast.unread'])).toBeInTheDocument()
    expect(screen.queryByText('No parish feasts yet.')).not.toBeInTheDocument()
  })
})
