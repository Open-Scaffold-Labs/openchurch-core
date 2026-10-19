// A sacramental anniversary names the person in the book. When the book
// has no name, the card says so — it does not borrow the live roster.

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import SacramentAnniversaries from './SacramentAnniversaries'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

function renderCard(locale) {
  localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async () => ok({
    anniversaries: [
      { id: 1, member_id: 9, member_name: 'Maria Ruiz', type: 'baptism', years: 5, next_date: '2026-05-10' },
      { id: 2, member_id: 9, member_name: null, type: 'baptism', years: 5, next_date: '2026-05-11' },
    ],
  })))
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <SacramentAnniversaries />
      </LocaleProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('anniversary names come from the register', () => {
  it('shows the recorded name and, in English, says when the book has none', async () => {
    renderCard('en')
    expect(await screen.findByText('Maria Ruiz')).toBeTruthy()
    expect(screen.getByText('Name not in the register')).toBeTruthy()
    expect(screen.queryByText('Maria Ruiz Garcia')).toBeNull()
  })

  it('says the same absence in Spanish without substituting a roster name', async () => {
    renderCard('es')
    expect(await screen.findByText('Maria Ruiz')).toBeTruthy()
    expect(screen.getByText('El nombre no consta en el registro')).toBeTruthy()
  })
})

describe('a failed anniversary read is not a quiet week', () => {
  function mount() {
    return render(
      <MemoryRouter>
        <LocaleProvider>
          <SacramentAnniversaries />
        </LocaleProvider>
      </MemoryRouter>
    )
  }

  it('stays off the page when the week is genuinely quiet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ anniversaries: [] })))
    mount()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByText(STRINGS.en['anniv.title'])).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a refused read is not a week with nothing to mark', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ anniversaries: [] }),
    })))
    mount()
    expect(await screen.findByRole('status')).toHaveTextContent(STRINGS.en['anniv.unread'])
    expect(screen.queryByText(STRINGS.en['anniv.title'])).toBeNull()
  })

  it('a body that is not a list is not a quiet week', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ anniversaries: null })))
    mount()
    expect(await screen.findByRole('status')).toHaveTextContent(STRINGS.en['anniv.unread'])
    expect(screen.queryByText(STRINGS.en['anniv.title'])).toBeNull()
  })

  it('Spanish names the failed read', async () => {
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503, json: async () => ({}),
    })))
    mount()
    expect(await screen.findByRole('status')).toHaveTextContent(STRINGS.es['anniv.unread'])
    expect(screen.queryByText(STRINGS.en['anniv.unread'])).toBeNull()
  })
})
