// A refused diocese read used to say "This parish is independent."
// A refused AI-provider read used to say the parish was on the built-in assistant.

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import OrgSettings from './OrgSettings'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Rector', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', timezone: 'UTC' } },
    updateUser: vi.fn(),
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

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) })

function stub({
  affiliation = ok({ affiliation: null }),
  provider = ok({ source: 'platform', provider: null, model: null, key_last4: null }),
  locale,
} = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    if (u.endsWith('/api/organization') && method === 'GET') return ok(ORG)
    if (u.includes('/api/parish-feasts')) return ok({ feasts: [] })
    if (u.includes('/api/affiliation')) return affiliation
    if (u.includes('/api/ai/provider')) return provider
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

const INDEPENDENT = /This parish is independent/i
const BUILTIN = /Using OpenChurch's built-in AI/i

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('parish status when a settings read is refused', () => {
  it('does not call a refused diocese link an independent parish', async () => {
    const en = STRINGS.en
    stub({ affiliation: refused() })
    mount()
    expect(await screen.findByText(en['org.affUnread'])).toBeInTheDocument()
    expect(screen.queryByText(INDEPENDENT)).not.toBeInTheDocument()
  })

  it('does not call a diocese body with no affiliation field an independent parish', async () => {
    const en = STRINGS.en
    stub({ affiliation: ok({}) })
    mount()
    expect(await screen.findByText(en['org.affUnread'])).toBeInTheDocument()
    expect(screen.queryByText(INDEPENDENT)).not.toBeInTheDocument()
  })

  it('still says when the parish truly has no diocese', async () => {
    const en = STRINGS.en
    stub({ affiliation: ok({ affiliation: null }) })
    mount()
    expect(await screen.findByText(INDEPENDENT)).toBeInTheDocument()
    expect(screen.queryByText(en['org.affUnread'])).not.toBeInTheDocument()
  })

  it('shows an affiliation that did load', async () => {
    const en = STRINGS.en
    stub({ affiliation: ok({ affiliation: { status: 'active', diocese_name: 'Diocese of Test', grant_level: 'summary' } }) })
    mount()
    expect(await screen.findByText('Diocese of Test')).toBeInTheDocument()
    expect(screen.queryByText(INDEPENDENT)).not.toBeInTheDocument()
    expect(screen.queryByText(en['org.affUnread'])).not.toBeInTheDocument()
  })

  it('does not call a refused provider the built-in assistant', async () => {
    const en = STRINGS.en
    stub({ provider: refused() })
    mount()
    expect(await screen.findByText(en['org.aiUnread'])).toBeInTheDocument()
    expect(screen.queryByText(BUILTIN)).not.toBeInTheDocument()
  })

  it('does not call a provider body with no source the built-in assistant', async () => {
    const en = STRINGS.en
    stub({ provider: ok({ provider: 'anthropic' }) })
    mount()
    expect(await screen.findByText(en['org.aiUnread'])).toBeInTheDocument()
    expect(screen.queryByText(BUILTIN)).not.toBeInTheDocument()
  })

  it('still says when the parish is on the built-in assistant', async () => {
    const en = STRINGS.en
    stub()
    mount()
    expect(await screen.findByText(BUILTIN)).toBeInTheDocument()
    expect(screen.queryByText(en['org.aiUnread'])).not.toBeInTheDocument()
  })

  it('shows a parish key that did load', async () => {
    const en = STRINGS.en
    stub({ provider: ok({ source: 'org', provider: 'anthropic', model: null, key_last4: '1234' }) })
    mount()
    expect(await screen.findByText(/your own key/i)).toBeInTheDocument()
    expect(screen.getByText('····1234')).toBeInTheDocument()
    expect(screen.queryByText(BUILTIN)).not.toBeInTheDocument()
    expect(screen.queryByText(en['org.aiUnread'])).not.toBeInTheDocument()
  })

  it('says the refused diocese link in Spanish', async () => {
    const es = STRINGS.es
    stub({ affiliation: refused(), locale: 'es' })
    mount()
    expect(await screen.findByText(es['org.affUnread'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['org.affUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(INDEPENDENT)).not.toBeInTheDocument()
  })
})
