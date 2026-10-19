// A refused read of GET /api/ai/generations used to toast and leave
// `rows` as [], so the page said "Your library is empty."

import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Library from './Library'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't',
    loading: false,
  }),
}))

const ROW = {
  id: 7,
  type: 'sermon',
  prompt: 'Palm Sunday humility',
  created_at: '2026-09-28T12:00:00Z',
  output: 'outline',
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) })

const EMPTY_TITLE = 'Your library is empty'

function stub({ history = ok({ rows: [], total: 0 }), locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async () => history))
}

function mount() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Library />
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

describe('library when the archive did not load', () => {
  it('does not call a refused archive an empty library', async () => {
    const en = STRINGS.en
    stub({ history: refused() })
    mount()
    expect(await screen.findByRole('heading', { name: en['load.failedTitle'] })).toBeInTheDocument()
    expect(screen.getByText(en['load.failedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
    expect(screen.queryByText('No matching generations')).not.toBeInTheDocument()
  })

  it('does not call a dropped connection an empty library', async () => {
    const en = STRINGS.en
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    mount()
    expect(await screen.findByRole('heading', { name: en['load.failedTitle'] })).toBeInTheDocument()
    expect(screen.getByText(en['load.failedBody'])).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
  })

  it('still says when the library truly has nothing yet', async () => {
    const en = STRINGS.en
    stub({ history: ok({ rows: [], total: 0 }) })
    mount()
    expect(await screen.findByText(EMPTY_TITLE)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: en['load.failedTitle'] })).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedBody'])).not.toBeInTheDocument()
  })

  it('shows a generation that came back', async () => {
    const en = STRINGS.en
    stub({ history: ok({ rows: [ROW], total: 1, hasMore: false }) })
    mount()
    expect(await screen.findByText('Palm Sunday humility')).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: en['load.failedTitle'] })).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedBody'])).not.toBeInTheDocument()
  })

  it.each([
    ['null rows', { rows: null, total: 0 }],
    ['missing rows', { total: 0 }],
    ['a rows object', { rows: { length: 0 }, total: 0 }],
  ])('a 200 with %s is not an empty library', async (_label, body) => {
    const en = STRINGS.en
    stub({ history: ok(body) })
    mount()
    expect(await screen.findByRole('heading', { name: en['load.failedTitle'] })).toBeInTheDocument()
    expect(screen.getByText(en['load.failedBody'])).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
  })

  it('says the same thing in Spanish when the archive did not load', async () => {
    const es = STRINGS.es
    const en = STRINGS.en
    stub({ history: refused(), locale: 'es' })
    mount()
    expect(await screen.findByRole('heading', { name: es['load.failedTitle'] })).toBeInTheDocument()
    expect(screen.getByText(es['load.failedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: en['load.failedTitle'] })).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedBody'])).not.toBeInTheDocument()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
  })

  it('retry reads the first page again', async () => {
    const en = STRINGS.en
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return calls === 1 ? refused() : ok({ rows: [ROW], total: 1, hasMore: false })
    }))
    mount()
    expect(await screen.findByRole('heading', { name: en['load.failedTitle'] })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en['load.retry'] }))
    expect(await screen.findByText('Palm Sunday humility')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: en['load.failedTitle'] })).not.toBeInTheDocument()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
  })

  it('a failed next page leaves the generations already loaded', async () => {
    const en = STRINGS.en
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('offset=0')) return ok({ rows: [ROW], total: 2, hasMore: true })
      return refused()
    }))
    mount()
    expect(await screen.findByText('Palm Sunday humility')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /load more/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Palm Sunday humility')).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_TITLE)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: en['load.failedTitle'] })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /load more/i })).toBeEnabled()
  })

  it('the pager speaks the parish language', async () => {
    const { en, es } = STRINGS
    stub({ history: ok({ rows: [ROW], total: 2, hasMore: true }), locale: 'es' })
    mount()
    expect(await screen.findByText('Palm Sunday humility')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es['mem.loadMore'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: en['mem.loadMore'] })).not.toBeInTheDocument()
  })
})
