// Schedule opens the intention book with the Mass already known.
// Mutate any one of these and the matching test goes red:
//   1. ?event=&date=&compose=1 no longer prefills the new-intention form
//   2. A garbled event id is treated as a real Mass
//   3. Durable ?event= is stripped after open (refresh loses the Mass)
//   4. Refresh / direct-load of ?event= reopens the form without compose=1
//   5. Durable ?event= no longer names the Mass in the page chrome

import { ToastProvider } from '../components/ToastProvider'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import MassIntentions, { readIntentionBookContext, parseIntentionEventId } from './MassIntentions'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const notFound = () => ({ ok: false, status: 404, json: async () => ({ error: 'Event not found' }) })

const HOP_MASS = { id: 1, title: '[Sample] Sunday Service', date: '2026-09-13', start_time: '10:00:00' }

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}{loc.search}</div>
}

function stubBookFetch({ byId = { 1: HOP_MASS }, list = [HOP_MASS], intentions = [] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    const m = u.match(/\/api\/calendar\/(\d+)/)
    if (m) return byId[m[1]] ? ok(byId[m[1]]) : notFound()
    if (u.includes('/api/calendar')) return ok(list)
    if (u.includes('/api/mass-intentions')) return ok({ intentions })
    return ok({})
  }))
}

beforeEach(() => {
  vi.unstubAllGlobals()
  stubBookFetch()
})

describe('readIntentionBookContext', () => {
  it('only a positive integer event and YYYY-MM-DD date count', () => {
    const sp = (q) => new URLSearchParams(q)
    expect(readIntentionBookContext(sp('event=1&date=2026-09-13'))).toEqual({
      calendar_event_id: '1', mass_date: '2026-09-13', hasContext: true,
    })
    expect(readIntentionBookContext(sp('event=Sunday&date=2026-09-13'))).toEqual({
      calendar_event_id: '', mass_date: '2026-09-13', hasContext: true,
    })
    expect(readIntentionBookContext(sp('event=0&date=nope'))).toEqual({
      calendar_event_id: '', mass_date: '', hasContext: false,
    })
    expect(readIntentionBookContext(sp('event=-3'))).toEqual({
      calendar_event_id: '', mass_date: '', hasContext: false,
    })
  })

  it('parseIntentionEventId accepts only a positive integer', () => {
    expect(parseIntentionEventId('1')).toBe(1)
    expect(parseIntentionEventId('Sunday')).toBeNull()
    expect(parseIntentionEventId('0')).toBeNull()
    expect(parseIntentionEventId(-3)).toBeNull()
  })
})

function renderBook(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <Routes>
          <Route path="/mass-intentions" element={<><LocationProbe /><ToastProvider><MassIntentions /></ToastProvider></>} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

describe('Mass Intentions book hop', () => {
  it('opens a new intention from compose=1 and keeps durable ?event=', async () => {
    renderBook('/mass-intentions?event=1&date=2026-09-13&compose=1')
    await waitFor(() => {
      expect(screen.getByText(/^New intention$/i)).toBeInTheDocument()
    })
    const dateInput = document.querySelector('input[type="date"]')
    expect(dateInput.value).toBe('2026-09-13')
    await waitFor(() => {
      const withVal = [...document.querySelectorAll('select')].find(s => {
        const opt = s.options[s.selectedIndex]
        return opt?.value === '1' && !s.options[0]?.selected
      })
      expect(withVal).toBeTruthy()
    })
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/mass-intentions?event=1&date=2026-09-13')
    })
    const back = screen.getByRole('link', { name: /back to this mass/i })
    expect(back.getAttribute('href')).toBe('/schedule?event=1')
  })

  it('refresh / direct-load of ?event= keeps Back and does not reopen the form', async () => {
    renderBook('/mass-intentions?event=1&date=2026-09-13')
    const back = await screen.findByRole('link', { name: /back to this mass/i })
    expect(back.getAttribute('href')).toBe('/schedule?event=1')
    expect(screen.queryByText(/^New intention$/i)).toBeNull()
    expect(screen.getByTestId('loc').textContent).toBe('/mass-intentions?event=1&date=2026-09-13')
  })

  it('a garbled event id does not invent a Back-to-this-Mass destination', async () => {
    renderBook('/mass-intentions?event=Sunday&date=2026-09-13&compose=1')
    await waitFor(() => {
      expect(screen.getByText(/^New intention$/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole('link', { name: /back to this mass/i })).toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/mass-intentions?event=Sunday&date=2026-09-13')
    })
  })

  it('date-only compose prefills the date and has no Back-to-this-Mass link', async () => {
    renderBook('/mass-intentions?date=2026-09-13&compose=1')
    await waitFor(() => {
      expect(screen.getByText(/^New intention$/i)).toBeInTheDocument()
    })
    expect(document.querySelector('input[type="date"]').value).toBe('2026-09-13')
    expect(screen.queryByRole('link', { name: /back to this mass/i })).toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/mass-intentions?date=2026-09-13')
    })
  })
})

describe('Mass identity chrome when ?event= is present', () => {
  it('names the resolved Mass in the chrome — not only the Back link', async () => {
    renderBook('/mass-intentions?event=1&date=2026-09-13')
    const chrome = await screen.findByTestId('intention-mass-chrome')
    expect(chrome.textContent).toMatch(/Sunday Service/)
    expect(chrome.textContent).toMatch(/2026/)
    expect(chrome.textContent).toMatch(/10:00/)
    expect(screen.getByRole('link', { name: /back to this mass/i })).toBeInTheDocument()
  })

  it('phone header stacks chrome above Weekly sheet so the Mass can wrap at words', async () => {
    renderBook('/mass-intentions?event=1&date=2026-09-13')
    const chrome = await screen.findByTestId('intention-mass-chrome')
    const header = screen.getByTestId('intention-book-header')
    expect(header.contains(chrome)).toBe(true)
    expect(header.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-col', 'sm:flex-row']))
    expect(header.className).not.toMatch(/flex-wrap/)
    expect(chrome.className).not.toMatch(/break-all|break-words/)
    expect(chrome.querySelector('p')?.className || '').not.toMatch(/break-all|break-words/)
    const weekly = screen.getByRole('link', { name: /weekly sheet/i })
    expect(header.contains(weekly)).toBe(true)
    expect(chrome.compareDocumentPosition(weekly) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('bare book has no Mass chrome and keeps the generic subtitle', async () => {
    renderBook('/mass-intentions')
    await screen.findByRole('heading', { name: /intentions/i })
    expect(screen.queryByTestId('intention-mass-chrome')).toBeNull()
    expect(screen.getByText(/requested intentions and their offerings/i)).toBeInTheDocument()
    expect(screen.queryByText(/Sunday Service/)).toBeNull()
  })

  it('a missing ?event= id is honest unknown and does not invent from ?date=', async () => {
    stubBookFetch({ byId: {}, list: [HOP_MASS] })
    renderBook('/mass-intentions?event=999&date=2026-03-01')
    const chrome = await screen.findByTestId('intention-mass-chrome')
    expect(chrome.textContent).toMatch(/isn't on this church's schedule/i)
    expect(chrome.textContent).not.toMatch(/Sunday Service/)
    expect(chrome.textContent).not.toMatch(/Mar/)
    expect(chrome.textContent).not.toMatch(/2026-03-01/)
    expect(screen.getByTestId('loc').textContent).toBe('/mass-intentions?event=999&date=2026-03-01')
    expect(screen.getByRole('link', { name: /back to this mass/i })).toBeInTheDocument()
  })

  it('a garbled ?event= does not invent Mass chrome', async () => {
    renderBook('/mass-intentions?event=Sunday&date=2026-09-13')
    await screen.findByRole('heading', { name: /intentions/i })
    expect(screen.queryByTestId('intention-mass-chrome')).toBeNull()
    expect(screen.queryByText(/Sunday Service/)).toBeNull()
    expect(screen.queryByRole('link', { name: /back to this mass/i })).toBeNull()
  })

  it('a failed lookup is honest and does not fall back to another Mass', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (/\/api\/calendar\/\d+/.test(u)) return { ok: false, status: 500, json: async () => ({}) }
      if (u.includes('/api/calendar')) return ok([HOP_MASS])
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
      return ok({})
    }))
    renderBook('/mass-intentions?event=777')
    const chrome = await screen.findByTestId('intention-mass-chrome')
    await waitFor(() => {
      expect(chrome.textContent).toMatch(/couldn't open that mass/i)
    })
    expect(chrome.textContent).not.toMatch(/Sunday Service/)
    expect(screen.getByTestId('loc').textContent).toBe('/mass-intentions?event=777')
  })
})
