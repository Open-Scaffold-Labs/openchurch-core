import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from './ToastProvider'
import MassIntentionAssign from './MassIntentionAssign'

const authState = vi.hoisted(() => ({ locale: 'en' }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: authState.locale } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const fail = (status = 500, body = {}) => ({ ok: false, status, json: async () => body })

const wrap = (node) => render(
  <MemoryRouter>
    <LocaleProvider>
      <ToastProvider>{node}</ToastProvider>
    </LocaleProvider>
  </MemoryRouter>
)

beforeEach(() => {
  authState.locale = 'en'
  vi.unstubAllGlobals()
})

describe('MassIntentionAssign', () => {
  const event = { id: 40, date: '2027-06-08', title: '9am Mass', type: 'service' }

  it('LOADING / FAILED / EMPTY / assigned are distinct', async () => {
    let resolveAwaiting
    vi.stubGlobal('fetch', vi.fn((url) => {
      if (String(url).includes('/awaiting')) {
        return new Promise((resolve) => { resolveAwaiting = resolve })
      }
      return Promise.resolve(ok({}))
    }))
    wrap(<MassIntentionAssign event={event} assigned={[]} />)
    expect(screen.getByText(/looking up open intentions/i)).toBeInTheDocument()

    resolveAwaiting(ok({ intentions: [] }))
    await waitFor(() => {
      expect(screen.getByText(/no open intentions are waiting/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/no intention is offered at this mass yet/i)).toBeInTheDocument()
  })

  it('surfaces a failed awaiting load without inventing an empty book', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      if (String(url).includes('/awaiting')) return Promise.resolve(fail())
      return Promise.resolve(ok({}))
    }))
    wrap(<MassIntentionAssign event={event} assigned={[]} />)
    await waitFor(() => {
      expect(screen.getByText(/couldn't load open intentions/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/no open intentions are waiting/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('offers an awaiting intention at this Mass and does not treat a refusal as success', async () => {
    const onChanged = vi.fn()
    const awaiting = [{ id: 7, intention: '† Rivera', requested_by: 'The family', calendar_event_id: null, status: 'open' }]
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      if (u.includes('/awaiting')) return ok({ intentions: awaiting })
      if (u.includes('/assign') && opts?.method === 'POST') {
        return fail(409, { error: 'This intention was just assigned elsewhere. Nothing was lost — please look again.' })
      }
      return ok({})
    }))
    wrap(<MassIntentionAssign event={event} assigned={[]} onChanged={onChanged} />)
    const offer = await screen.findByRole('button', { name: /offer at this mass/i })
    await act(async () => { fireEvent.click(offer) })
    await waitFor(() => {
      expect(screen.getByText(/just assigned elsewhere/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/offered at this mass\./i)).not.toBeInTheDocument()
  })

  it('a Spanish session shows the recorded-fulfilment sentence, not the English server text', async () => {
    authState.locale = 'es'
    const awaiting = [{ id: 7, intention: '† Rivera', requested_by: 'La familia', calendar_event_id: null, status: 'open' }]
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      if (u.includes('/awaiting')) return ok({ intentions: awaiting })
      if (u.includes('/assign') && opts?.method === 'POST') {
        return fail(409, {
          error: 'This intention was already recorded at a Mass. The link was not changed. Nothing was lost.',
          code: 'stamped_history',
        })
      }
      if (u.includes('/unassign') && opts?.method === 'POST') {
        return fail(409, {
          error: 'This intention was already recorded at a Mass. The link was not changed. Nothing was lost.',
          code: 'stamped_history',
        })
      }
      return ok({})
    }))
    wrap(<MassIntentionAssign event={event} assigned={[{ id: 3, intention: '† Ana', requested_by: 'Ana' }]} />)
    const offer = await screen.findByRole('button', { name: /ofrecer en esta misa/i })
    await act(async () => { fireEvent.click(offer) })
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(STRINGS.es['mi.stampedHistory'])
    })
    expect(screen.queryByText(/already recorded at a Mass/i)).not.toBeInTheDocument()

    const release = screen.getByRole('button', { name: /quitar: † ana/i })
    await act(async () => { fireEvent.click(release) })
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(STRINGS.es['mi.stampedHistory'])
    })
    expect(screen.queryByText(/already recorded at a Mass/i)).not.toBeInTheDocument()
  })

  it('names the intention on Offer and Release so two rows are not the same action', async () => {
    const assigned = [{ id: 9, intention: '† ALPHA INTENTION — Rivera', formatted_intention: '† ALPHA INTENTION — Rivera', calendar_event_id: 40, status: 'scheduled' }]
    const awaiting = [{ id: 10, intention: '† OMEGA INTENTION — Thanksgiving', calendar_event_id: null, status: 'open' }]
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/awaiting')) return ok({ intentions: awaiting })
      return ok({})
    }))
    wrap(<MassIntentionAssign event={event} assigned={assigned} />)
    expect(await screen.findByRole('button', { name: /offer at this mass.*OMEGA INTENTION/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /release.*ALPHA INTENTION/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /offer at this mass.*ALPHA INTENTION/i })).not.toBeInTheDocument()
  })

  it('double-click does not fire two writes', async () => {
    const awaiting = [{ id: 8, intention: 'Thanksgiving', calendar_event_id: null, status: 'open' }]
    let assigns = 0
    let releaseAssign
    vi.stubGlobal('fetch', vi.fn((url, opts) => {
      const u = String(url)
      if (u.includes('/awaiting')) return Promise.resolve(ok({ intentions: awaiting }))
      if (u.includes('/assign') && opts?.method === 'POST') {
        assigns += 1
        return new Promise((resolve) => { releaseAssign = () => resolve(ok({ id: 8, calendar_event_id: 40, status: 'scheduled' })) })
      }
      return Promise.resolve(ok({}))
    }))
    wrap(<MassIntentionAssign event={event} assigned={[]} />)
    const offer = await screen.findByRole('button', { name: /offer at this mass/i })
    fireEvent.click(offer)
    fireEvent.click(offer)
    expect(assigns).toBe(1)
    await act(async () => { releaseAssign() })
    await waitFor(() => expect(screen.getByText('Offered at this Mass.')).toBeInTheDocument())
  })
})

import { intentionBookHref } from './MassIntentionAssign'

describe('intentionBookHref', () => {
  it('carries the open Mass id and date into the book', () => {
    expect(intentionBookHref({ id: 1, date: '2026-09-13' })).toBe('/mass-intentions?event=1&date=2026-09-13&compose=1')
    expect(intentionBookHref({ id: 40, date: '2027-06-08T00:00:00.000Z' })).toBe('/mass-intentions?event=40&date=2027-06-08&compose=1')
  })

  it('does not invent a Mass from a missing or garbled id', () => {
    expect(intentionBookHref({ date: '2026-09-13' })).toBe('/mass-intentions?date=2026-09-13')
    expect(intentionBookHref({ id: 'Sunday Service', date: '2026-09-13' })).toBe('/mass-intentions?date=2026-09-13')
    expect(intentionBookHref({ id: 0, date: '2026-09-13' })).toBe('/mass-intentions?date=2026-09-13')
    expect(intentionBookHref({ id: -1, date: '2026-09-13' })).toBe('/mass-intentions?date=2026-09-13')
    expect(intentionBookHref({ id: 1.5, date: '2026-09-13' })).toBe('/mass-intentions?date=2026-09-13')
    expect(intentionBookHref({})).toBe('/mass-intentions')
    expect(intentionBookHref(null)).toBe('/mass-intentions')
  })

  it('the Open the intention book link uses that href', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/awaiting')) return ok({ intentions: [] })
      return ok({})
    }))
    wrap(<MassIntentionAssign event={{ id: 1, date: '2026-09-13', title: 'Sunday', type: 'service' }} assigned={[]} />)
    const link = await screen.findByRole('link', { name: /open the intention book/i })
    expect(link.getAttribute('href')).toBe('/mass-intentions?event=1&date=2026-09-13&compose=1')
  })

  it('a meeting does not offer an intention at that event', () => {
    wrap(<MassIntentionAssign event={{ id: 2, date: '2026-10-04', title: 'Finance', type: 'meeting' }} assigned={[]} />)
    expect(screen.queryByText(/mass intentions/i)).toBeNull()
    expect(screen.queryByRole('link', { name: /open the intention book/i })).toBeNull()
  })

  it('a Mass stored as type mass or event offers an intention', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ intentions: [] })))
    wrap(<MassIntentionAssign event={{ id: 3, date: '2026-10-04', title: 'Misa', type: 'mass' }} assigned={[]} />)
    wrap(<MassIntentionAssign event={{ id: 4, date: '2026-10-04', title: '10:30 Mass', type: 'event' }} assigned={[]} />)
    expect(await screen.findAllByText(/mass intentions/i)).toHaveLength(2)
  })
})
