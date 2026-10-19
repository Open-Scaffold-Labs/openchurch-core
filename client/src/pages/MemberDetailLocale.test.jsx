// LOC-L0-02 — Member Detail audited chrome is localized.
// Mutate any one of these and the matching test goes red:
//   1. "View change history" is hard-coded English on es
//   2. "Record a sacrament" is hard-coded English on es
//   3. Section chrome (Contact / Donation history / Attendance) stays English on es
//   4. EN still uses the English chrome
//   5. A missing key falls through to the key itself, not a blank

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider, useLocale } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MemberDetail from './MemberDetail'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const MEMBER = {
  id: 22002,
  name: 'Sample Baptismal Member',
  email: 'sample@x.com',
  status: 'active',
  role: 'Staff',
  created_at: '2026-01-15T00:00:00Z',
  updated_at: '2026-01-16T00:00:00Z',
}

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes(`/api/clients/${MEMBER.id}/donations`)) return ok({ lines: [], total: 0, gift_count: 0 })
    if (u.match(/\/api\/clients\/\d+$/)) return ok(MEMBER)
    if (u.includes('/api/sacraments')) return ok({ records: [] })
    return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] })
  }))
}

function mount() {
  return render(
    <MemoryRouter initialEntries={[`/clients/${MEMBER.id}`]}>
      <LocaleProvider><ToastProvider><ConfirmProvider>
        <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
      </ConfirmProvider></ToastProvider></LocaleProvider>
    </MemoryRouter>,
  )
}

function Probe({ k }) {
  const { t } = useLocale()
  return <p data-testid="missing">{t(k)}</p>
}

const NEW_KEYS = [
  'member.viewHistory',
  'member.viewHistoryTitle',
  'member.recordSacrament',
  'member.attendance',
  'member.donationHistory',
  'member.activePledges',
  'member.noContact',
  'member.updatedOn',
  'member.notFound',
  'member.notFoundBody',
  'member.swapLink',
  'member.availability',
  'member.generateLink',
  'member.rotateLink',
  'member.generating',
  'member.copy',
  'member.copied',
  'member.copyFailed',
  'member.addBlackout',
  'member.adding',
  'member.save',
  'member.saveChanges',
  'member.savedWhatRecord',
  'member.savedWhatCorrection',
  'member.savedListStale',
  'member.listStale',
  'member.failedStatus',
  'member.failedToLoad',
  'member.entriesUnread',
]

const CHROME_KEYS = [
  'member.swapLink',
  'member.availability',
  'member.generateLink',
  'member.addBlackout',
]

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  stubFetch()
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('LOC-L0-02 Member Detail chrome', () => {
  it('EN shows the audited English chrome', async () => {
    mount()
    await waitFor(() => expect(screen.getByText(MEMBER.name)).toBeInTheDocument())
    expect(screen.getByText('View change history')).toBeInTheDocument()
    expect(screen.getByText('Record a sacrament')).toBeInTheDocument()
    expect(screen.getByText('Contact')).toBeInTheDocument()
    expect(screen.getByText('Donation history')).toBeInTheDocument()
    for (const k of CHROME_KEYS) {
      expect(screen.getByText(STRINGS.en[k]), k).toBeInTheDocument()
    }
  })

  it('ES replaces the audited chrome and section headings', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    await waitFor(() => expect(screen.getByText(MEMBER.name)).toBeInTheDocument())
    expect(screen.getByText('Ver historial de cambios')).toBeInTheDocument()
    expect(screen.getByText('Registrar un sacramento')).toBeInTheDocument()
    expect(screen.getByText('Contacto')).toBeInTheDocument()
    expect(screen.getByText('Historial de donativos')).toBeInTheDocument()
    expect(screen.queryByText('View change history')).not.toBeInTheDocument()
    expect(screen.queryByText('Record a sacrament')).not.toBeInTheDocument()
    expect(screen.queryByText('Donation history')).not.toBeInTheDocument()
    for (const k of CHROME_KEYS) {
      expect(screen.getByText(STRINGS.es[k]), k).toBeInTheDocument()
      expect(screen.queryByText(STRINGS.en[k]), k).not.toBeInTheDocument()
    }
  })

  it('ES not-found is the page title, not the English empty state', async () => {
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    mount()
    expect(await screen.findByText(STRINGS.es['member.notFound'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['member.notFoundBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['member.notFound'])).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['member.notFoundBody'])).not.toBeInTheDocument()
  })

  it('new keys exist in both locales and a missing key is not blank', () => {
    for (const k of NEW_KEYS) {
      expect(STRINGS.en[k], k).toBeTruthy()
      expect(STRINGS.es[k], k).toBeTruthy()
      expect(STRINGS.es[k]).not.toBe(STRINGS.en[k])
    }
    expect(STRINGS.en['member.notFound']).toBe('Member not found')
    expect(STRINGS.en['member.savedListStale']).toMatch(/was saved, but this list could not be refreshed/)
    expect(STRINGS.en['err.save']).toMatch(/nothing was lost/)
    render(
      <LocaleProvider>
        <Probe k="member.doesNotExist" />
      </LocaleProvider>,
    )
    expect(screen.getByTestId('missing').textContent).toBe('member.doesNotExist')
    expect(screen.getByTestId('missing').textContent).not.toBe('')
  })
})
