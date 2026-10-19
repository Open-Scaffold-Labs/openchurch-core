// A refused audit-log read must not look like a parish with no activity.
//
// GET /api/audit-log?... used to toast and leave `rows` at []. The body
// then rendered EmptyState "Nothing recorded yet" (or "No matching
// activity" when filters were set). 403 stays the admins-only path.

import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import Audit from './Audit'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const en = STRINGS.en
const es = STRINGS.es

const ROW = {
  id: 7,
  created_at: '2026-09-01T15:00:00.000Z',
  user_name: 'Sacristan',
  user_email: 'sacristan@parish.test',
  action: 'update',
  entity_type: 'parish_feast',
  summary: 'Updated the parish feast',
  status_code: 200,
}

const QUIET = 'Nothing recorded yet'
const FILTERED_QUIET = 'No matching activity'

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const refused = () => ok({ error: 'no' }, 500)
const forbidden = () => ok({ error: 'forbidden' }, 403)
const thrown = () => Promise.reject(new Error('offline'))
const badJson = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })

function stub(handler) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (!u.includes('/api/audit-log') || u.includes('/export')) return ok({})
    return handler(u)
  }))
}

function mount(locale) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <Audit />
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('the audit log read', () => {
  it.each(['en', 'es'])('the %s page heading follows the session language', async (locale) => {
    stub(() => ok({ rows: [ROW], total: 1, hasMore: false }))
    mount(locale)
    expect(await screen.findByText(ROW.summary)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS[locale]['audit.title'] })).toBeInTheDocument()
    if (locale === 'es') {
      expect(screen.queryByRole('heading', { name: en['audit.title'] })).not.toBeInTheDocument()
    }
  })

  it.each(['en', 'es'])('the %s forbidden state follows the session language', async (locale) => {
    stub(() => forbidden())
    mount(locale)
    expect(await screen.findByRole('heading', { name: STRINGS[locale]['audit.adminOnly'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS[locale]['audit.adminOnlyBody'])).toBeInTheDocument()
    expect(screen.queryByText(QUIET)).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS[locale]['load.failedTitle'])).not.toBeInTheDocument()
    if (locale === 'es') {
      expect(screen.queryByRole('heading', { name: en['audit.adminOnly'] })).not.toBeInTheDocument()
      expect(screen.queryByText(en['audit.adminOnlyBody'])).not.toBeInTheDocument()
    }
  })

  it('a refused first page is the failure copy, not a quiet parish', async () => {
    stub(() => refused())
    mount()
    expect(await screen.findByText(en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.getByText(en['load.failedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(QUIET)).not.toBeInTheDocument()
    expect(screen.queryByText(FILTERED_QUIET)).not.toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(en['err.load'])
  })

  it('a thrown first page is the failure copy, not a quiet parish', async () => {
    stub(() => thrown())
    mount()
    expect(await screen.findByText(en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.getByText(en['load.failedBody'])).toBeInTheDocument()
    expect(screen.queryByText(QUIET)).not.toBeInTheDocument()
  })

  it.each([
    ['a missing rows field', {}],
    ['a null rows field', { rows: null }],
    ['a rows object', { rows: { id: 1 } }],
    ['a top-level array', []],
    ['a null body', null],
  ])('%s is a failed read, not an empty log', async (_label, body) => {
    stub(() => ok(body))
    mount()
    expect(await screen.findByText(en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.getByText(en['load.failedBody'])).toBeInTheDocument()
    expect(screen.queryByText(QUIET)).not.toBeInTheDocument()
  })

  it('a malformed JSON body is a failed read, not an empty log', async () => {
    stub(() => badJson())
    mount()
    expect(await screen.findByText(en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.queryByText(QUIET)).not.toBeInTheDocument()
  })

  it('a real empty list stays the empty title, not the failure', async () => {
    stub(() => ok({ rows: [], total: 0, hasMore: false }))
    mount()
    expect(await screen.findByText(QUIET)).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedBody'])).not.toBeInTheDocument()
    expect(screen.queryByText(es['load.failedTitle'])).not.toBeInTheDocument()
  })

  it('one recorded row shows', async () => {
    stub(() => ok({ rows: [ROW], total: 1, hasMore: false }))
    mount()
    expect(await screen.findByText(ROW.summary)).toBeInTheDocument()
    expect(screen.getByText('Sacristan')).toBeInTheDocument()
    expect(screen.queryByText(QUIET)).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
  })

  it('a Spanish session hears the Spanish failure, not a quiet parish', async () => {
    stub(() => refused())
    mount('es')
    expect(await screen.findByText(es['load.failedTitle'])).toBeInTheDocument()
    expect(screen.getByText(es['load.failedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedBody'])).not.toBeInTheDocument()
    expect(screen.queryByText(QUIET)).not.toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(es['err.load'])
    expect(screen.queryByText(en['err.load'])).not.toBeInTheDocument()
  })

  it('a 403 still shows the admins-only path', async () => {
    stub(() => forbidden())
    mount()
    expect(await screen.findByRole('heading', { name: 'Admins only' })).toBeInTheDocument()
    expect(screen.queryByText(QUIET)).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedBody'])).not.toBeInTheDocument()
  })

  it('a failed next page leaves the rows already read', async () => {
    stub((u) => {
      if (u.includes('offset=0')) return ok({ rows: [ROW], total: 2, hasMore: true })
      return refused()
    })
    mount()
    expect(await screen.findByText(ROW.summary)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(en['err.load'])
    expect(screen.getByText(ROW.summary)).toBeInTheDocument()
    expect(screen.queryByText(QUIET)).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
  })

  it('retry after a refusal reads the first page again', async () => {
    let calls = 0
    stub(() => {
      calls += 1
      return calls === 1 ? refused() : ok({ rows: [ROW], total: 1, hasMore: false })
    })
    mount()
    expect(await screen.findByText(en['load.failedTitle'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en['load.retry'] }))
    expect(await screen.findByText(ROW.summary)).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(QUIET)).not.toBeInTheDocument()
  })
})
