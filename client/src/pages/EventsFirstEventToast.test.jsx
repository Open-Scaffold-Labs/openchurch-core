// R309-1 (TARS on #309): the first-event toast must take the parish's
// prior event count ONLY from a settled, successful, unfiltered first-page
// read. A pending read or a filtered list (even after the search box is
// cleared) is unknown: it must neither celebrate nor retire the flag.
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Events from './Events'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const FIRST = 'First event on the books. The schedule is taking shape.'
const FLAG = 'ochr_first_event'
const ok = (body, status = 200) => ({ ok: true, status, json: async () => body })
const ev = (id, title) => ({ id, title, service_division: '', date: '2026-10-25', time: '10:00', location: '', assigned_members: [] })

// `unfiltered` decides each unfiltered first-page read: an array answers at
// once; 'hold' parks it until release() is called.
function stub({ unfiltered = [[]], filtered = [] } = {}) {
  const queue = [...unfiltered]
  const held = []
  const posts = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('/api/events') && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return ok({ id: 900, title: 'New' }, 201) }
    if (u.includes('/api/events') && u.includes('search=')) return ok(filtered)
    if (u.includes('/api/events')) {
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next === 'hold') return new Promise(r => held.push(() => r(ok([]))))
      return ok(next)
    }
    if (u.includes('/api/clients')) return ok([])
    return ok({})
  }))
  return { posts, held, release: () => held.splice(0).forEach(f => f()) }
}

const mount = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Events />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

async function createEvent(posts) {
  fireEvent.click(screen.getAllByRole('button', { name: /Add Event/ })[0])
  fireEvent.change(await screen.findByPlaceholderText('Event title'), { target: { value: 'Parish picnic' } })
  fireEvent.submit(screen.getByPlaceholderText('Event title').closest('form'))
  await waitFor(() => expect(posts).toHaveLength(1))
  await act(async () => { await new Promise(r => setTimeout(r, 30)) })
}

beforeEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

describe('first-event toast follows a settled unfiltered count (R309-1)', () => {
  it('create before the first read settles: no toast, flag untouched', async () => {
    const s = stub({ unfiltered: ['hold'] })
    mount()
    await createEvent(s.posts)
    expect(screen.queryByText(FIRST)).not.toBeInTheDocument()
    expect(localStorage.getItem(FLAG)).toBeNull()
    await act(async () => { s.release() })
  })

  it('filtered-empty, clear search, create before the unfiltered read settles: no toast, flag untouched', async () => {
    const s = stub({ unfiltered: [[ev(1, 'Choir practice'), ev(2, 'Bible study')], 'hold'], filtered: [] })
    mount()
    await screen.findByText('Choir practice')
    const box = screen.getByPlaceholderText('Search by title, division, location...')
    fireEvent.change(box, { target: { value: 'zzz' } })
    await waitFor(() => expect(screen.queryByText('Choir practice')).not.toBeInTheDocument(), { timeout: 2000 })
    fireEvent.change(box, { target: { value: '' } })
    await createEvent(s.posts)
    expect(screen.queryByText(FIRST)).not.toBeInTheDocument()
    expect(localStorage.getItem(FLAG)).toBeNull()
    await act(async () => { s.release() })
  })

  it('CONTROL: a settled empty book celebrates the first event', async () => {
    const s = stub({ unfiltered: [[]] })
    mount()
    await screen.findByText(/No events yet/)
    await createEvent(s.posts)
    expect(await screen.findByText(FIRST)).toBeInTheDocument()
    expect(localStorage.getItem(FLAG)).toBe('1')
  })

  it('CONTROL: a settled non-empty book does not celebrate and retires the toast', async () => {
    const s = stub({ unfiltered: [[ev(1, 'Choir practice')]] })
    mount()
    await screen.findByText('Choir practice')
    await createEvent(s.posts)
    expect(screen.queryByText(FIRST)).not.toBeInTheDocument()
    expect(localStorage.getItem(FLAG)).toBe('1')
  })
})
