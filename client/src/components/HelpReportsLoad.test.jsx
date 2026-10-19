// A failed read of the reporter's own reports used to become an empty
// list, and the panel only renders that list when it has rows. Failure
// and "you haven't sent any" were the same silence.

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import HelpPanel from './HelpPanel'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false }),
}))

const TICKET = {
  id: 41,
  status: 'new',
  created_at: '2031-06-15T12:00:00Z',
  description: 'The sacristy sheet skipped Sunday.',
}

function openReport(locale) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  const strings = locale === 'es' ? STRINGS.es : STRINGS.en
  render(
    <LocaleProvider>
      <HelpPanel open onClose={() => {}} />
    </LocaleProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: strings['help.tabReport'] }))
  return strings
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('earlier reports', () => {
  it('shows a report that came back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ tickets: [TICKET] }),
    })))
    openReport()
    expect(await screen.findByText(STRINGS.en['sup.myReports'])).toBeInTheDocument()
    expect(screen.getByText(TICKET.description)).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says nothing when the list is genuinely empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ tickets: [] }),
    })))
    openReport()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.getByText(STRINGS.en['sup.reportIntro'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['sup.myReports'])).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a refused read is not a parish with no reports', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ tickets: [] }),
    })))
    const strings = openReport()
    expect(await screen.findByRole('status')).toHaveTextContent(strings['sup.reportsUnread'])
    expect(screen.queryByText(strings['sup.myReports'])).toBeNull()
  })

  it('a body that is not a list is not a parish with no reports', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ tickets: { id: 1 } }),
    })))
    const strings = openReport()
    expect(await screen.findByRole('status')).toHaveTextContent(strings['sup.reportsUnread'])
    expect(screen.queryByText(strings['sup.myReports'])).toBeNull()
  })

  it('Spanish names the failed read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503, json: async () => ({}),
    })))
    const strings = openReport('es')
    expect(await screen.findByRole('status')).toHaveTextContent(strings['sup.reportsUnread'])
    expect(screen.queryByText(STRINGS.en['sup.reportsUnread'])).toBeNull()
  })
})
