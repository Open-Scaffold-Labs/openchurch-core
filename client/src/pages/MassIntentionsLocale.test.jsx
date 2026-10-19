// APPLE-INTENTIONS-L1-01 — the intention book in a real English session
// and a real Spanish session. Accessible names, the unread book, the
// empty book, and the "couldn't confirm this Mass" sentence all come
// from strings.js. Restoring an English aria-label or an English
// failure sentence makes the Spanish case go red.

import { ToastProvider } from '../components/ToastProvider'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import MassIntentions from './MassIntentions'

const authState = vi.hoisted(() => ({ locale: 'en' }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      name: 'Secretary',
      role: 'admin',
      organization: { id: 1, name: 'St Test', locale: authState.locale, tradition: 'catholic' },
    },
    token: 't',
    loading: false,
    canWrite: true,
    isAdmin: true,
  }),
}))

const ROW = {
  id: 15,
  intention: 'For a safe journey',
  requested_by: 'The family',
  mass_date: '2026-09-16',
  status: 'open',
  stipend: 10,
}

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const httpError = (status) => ({ ok: false, status, json: async () => ({}) })

function renderBook(path = '/mass-intentions') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <Routes>
          <Route path="/mass-intentions" element={<ToastProvider><MassIntentions /></ToastProvider>} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function copy(locale, key) {
  return STRINGS[locale][key]
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  authState.locale = 'en'
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.unstubAllGlobals()
})

describe('APPLE-INTENTIONS-L1-01 string table', () => {
  const keys = [
    'mi.edit',
    'mi.delete',
    'mi.loading',
    'mi.loadFailed',
    'mi.deleteFailed',
    'err.save',
    'mi.emptyTitle',
    'mi.emptyBody',
    'mi.required',
    'mi.massHeldFailed',
  ]

  it('English and Spanish both have the book sentences, and Spanish is not a copy', () => {
    for (const key of keys) {
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(STRINGS.en['mi.edit']).toBe('Edit intention')
    expect(STRINGS.en['mi.delete']).toBe('Delete intention')
    expect(STRINGS.en['mi.loadFailed']).toMatch(/couldn't load the intention book/i)
    expect(STRINGS.en['mi.deleteFailed']).toMatch(/intention is untouched/i)
    expect(STRINGS.en['mi.massHeldFailed']).toMatch(/couldn't confirm this mass/i)
  })

  it('the book no longer hard-codes the English row names or failure sentences', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MassIntentions.jsx'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/aria-label="Edit intention"/)
    expect(code).not.toMatch(/aria-label="Delete intention"/)
    expect(code).not.toMatch(/Couldn't load the intention book/)
    expect(code).not.toMatch(/That didn't delete — the intention is untouched/)
    expect(code).not.toMatch(/That didn't save — nothing was lost/)
    expect(code).toMatch(/aria-label=\{t\('mi\.edit'\)\}/)
    expect(code).toMatch(/aria-label=\{t\('mi\.delete'\)\}/)
    expect(code).toMatch(/t\('mi\.loadFailed'\)/)
    expect(code).toMatch(/t\('mi\.deleteFailed'\)/)
    expect(code).toMatch(/t\('err\.save'\)/)
    expect(code).not.toMatch(/throw new Error\(d\.error/)
    expect(code).not.toMatch(/setError\(err\.message\)/)
  })
})

const SAVE_ORACLE = {
  en: "That didn't save — nothing was lost. Please try again.",
  es: 'No se guardó — no se perdió nada. Inténtelo de nuevo, por favor.',
}
const DELETE_ORACLE = {
  en: "That didn't delete — the intention is untouched. Please try again.",
  es: 'No se eliminó — la intención no cambió. Intente de nuevo.',
}

for (const locale of ['en', 'es']) {
  describe(`APPLE-INTENTIONS-L1-01 rendered ${locale}`, () => {
    beforeEach(() => {
      authState.locale = locale
    })

    it('a reopened stamped row says previously recorded fulfilment, not plain fulfilled', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ok({
        intentions: [
          {
            id: 15,
            intention: 'For a safe journey',
            requested_by: 'The family',
            mass_date: '2026-09-16',
            status: 'scheduled',
            fulfilment_label: 'previously recorded fulfilment',
          },
          {
            id: 16,
            intention: 'For the parish',
            requested_by: 'The office',
            mass_date: '2026-09-16',
            status: 'fulfilled',
            fulfilment_label: null,
          },
        ],
      })))
      renderBook()
      expect(await screen.findByText(copy(locale, 'mi.previouslyRecorded'))).toBeInTheDocument()
      const row = screen.getByText('For a safe journey').closest('tr')
      expect(row).toHaveTextContent(copy(locale, 'mi.previouslyRecorded'))
      expect(row).toHaveTextContent(copy(locale, 'mi.scheduled'))
      expect(row).not.toHaveTextContent(copy(locale, 'mi.fulfilled'))
      expect(copy(locale, 'mi.previouslyRecorded')).not.toBe(copy(locale, 'mi.fulfilled'))
      expect(copy(locale, 'mi.previouslyRecorded').toLowerCase()).not.toBe('fulfilled')
    })

    it('names the book while it is loading', () => {
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
      renderBook()
      expect(screen.getByRole('status', { name: copy(locale, 'mi.loading') })).toBeInTheDocument()
    })

    it('an empty book says the empty sentence, not a failure', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ok({ intentions: [] })))
      renderBook()
      expect(await screen.findByRole('heading', { name: copy(locale, 'mi.emptyTitle') })).toBeInTheDocument()
      expect(screen.getByText(copy(locale, 'mi.emptyBody'))).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('a failed read is an alert, not an empty book', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => httpError(500)))
      renderBook()
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(copy(locale, 'mi.loadFailed'))
      expect(screen.queryByRole('heading', { name: copy(locale, 'mi.emptyTitle') })).not.toBeInTheDocument()
    })

    it('a listed intention names edit and delete in this language', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ok({ intentions: [ROW] })))
      renderBook()
      expect(await screen.findByText('For a safe journey')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: copy(locale, 'mi.edit') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: copy(locale, 'mi.delete') })).toBeInTheDocument()
      expect(screen.getByRole('searchbox', { name: copy(locale, 'mi.search') })).toBeInTheDocument()
      expect(screen.getByRole('combobox', { name: copy(locale, 'mi.allStatuses') })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: copy(locale, 'mi.title') })).toBeInTheDocument()
    })

    it('saving with no intention names what is missing', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ok({ intentions: [] })))
      renderBook()
      fireEvent.click(await screen.findByRole('button', { name: copy(locale, 'mi.add') }))
      fireEvent.click(screen.getByRole('button', { name: copy(locale, 'mi.save') }))
      expect(screen.getByRole('alert')).toHaveTextContent(copy(locale, 'mi.required'))
    })

    it('a refused save says nothing was lost', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
        const method = opts.method || 'GET'
        if (method === 'POST') return httpError(500)
        if (String(url).includes('/api/calendar')) return ok([])
        return ok({ intentions: [] })
      }))
      renderBook()
      fireEvent.click(await screen.findByRole('button', { name: copy(locale, 'mi.add') }))
      fireEvent.change(screen.getByLabelText(copy(locale, 'mi.intention')), { target: { value: 'For a safe journey' } })
      fireEvent.click(screen.getByRole('button', { name: copy(locale, 'mi.save') }))
      expect(await screen.findByRole('alert')).toHaveTextContent(copy(locale, 'err.save'))
      expect(screen.getByLabelText(copy(locale, 'mi.intention'))).toHaveValue('For a safe journey')
    })

    it('a server English save error stays in the log and the book sentence stays on screen', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
        const method = opts.method || 'GET'
        if (method === 'POST') return { ok: false, status: 500, json: async () => ({ error: 'Failed to save Mass intention' }) }
        if (String(url).includes('/api/calendar')) return ok([])
        return ok({ intentions: [] })
      }))
      renderBook()
      fireEvent.click(await screen.findByRole('button', { name: copy(locale, 'mi.add') }))
      fireEvent.change(screen.getByLabelText(copy(locale, 'mi.intention')), { target: { value: 'For a safe journey' } })
      fireEvent.click(screen.getByRole('button', { name: copy(locale, 'mi.save') }))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(SAVE_ORACLE[locale])
      expect(alert).not.toHaveTextContent('Failed to save Mass intention')
      expect(screen.getByLabelText(copy(locale, 'mi.intention'))).toHaveValue('For a safe journey')
      const logged = errSpy.mock.calls.flat().map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
      expect(logged).toContain('Failed to save Mass intention')
      errSpy.mockRestore()
    })

    it('a rejected save keeps the typed intention and does not show the network sentence', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
        const method = opts.method || 'GET'
        if (method === 'POST') return Promise.reject(new TypeError('Failed to fetch'))
        if (String(url).includes('/api/calendar')) return ok([])
        return ok({ intentions: [] })
      }))
      renderBook()
      fireEvent.click(await screen.findByRole('button', { name: copy(locale, 'mi.add') }))
      fireEvent.change(screen.getByLabelText(copy(locale, 'mi.intention')), { target: { value: 'For a safe journey' } })
      fireEvent.click(screen.getByRole('button', { name: copy(locale, 'mi.save') }))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(SAVE_ORACLE[locale])
      expect(alert).not.toHaveTextContent('Failed to fetch')
      expect(screen.getByLabelText(copy(locale, 'mi.intention'))).toHaveValue('For a safe journey')
      const logged = errSpy.mock.calls.flat().map(part => (part instanceof Error ? part.message : String(part))).join(' ')
      expect(logged).toContain('Failed to fetch')
      errSpy.mockRestore()
    })

    it('another English save error is also the book sentence', async () => {
      const other = 'Mass not found on your calendar'
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
        const method = opts.method || 'GET'
        if (method === 'POST') return { ok: false, status: 404, json: async () => ({ error: other }) }
        if (String(url).includes('/api/calendar')) return ok([])
        return ok({ intentions: [] })
      }))
      renderBook()
      fireEvent.click(await screen.findByRole('button', { name: copy(locale, 'mi.add') }))
      fireEvent.change(screen.getByLabelText(copy(locale, 'mi.intention')), { target: { value: 'For a safe journey' } })
      fireEvent.click(screen.getByRole('button', { name: copy(locale, 'mi.save') }))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(SAVE_ORACLE[locale])
      expect(alert).not.toHaveTextContent(other)
      expect(screen.getByLabelText(copy(locale, 'mi.intention'))).toHaveValue('For a safe journey')
      const logged = errSpy.mock.calls.flat().map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
      expect(logged).toContain(other)
      errSpy.mockRestore()
    })

    it('a refused delete says the intention is untouched', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
        const method = opts.method || 'GET'
        if (method === 'DELETE') return httpError(500)
        return ok({ intentions: [ROW] })
      }))
      renderBook()
      fireEvent.click(await screen.findByRole('button', { name: copy(locale, 'mi.delete') }))
      expect(await screen.findByRole('alert')).toHaveTextContent(DELETE_ORACLE[locale])
      expect(screen.getByText('For a safe journey')).toBeInTheDocument()
    })

    it('a rejected delete keeps the row and does not show the network sentence', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
        const method = opts.method || 'GET'
        if (method === 'DELETE') return Promise.reject(new TypeError('Failed to fetch'))
        return ok({ intentions: [ROW] })
      }))
      renderBook()
      fireEvent.click(await screen.findByRole('button', { name: copy(locale, 'mi.delete') }))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(DELETE_ORACLE[locale])
      expect(alert).not.toHaveTextContent('Failed to fetch')
      expect(screen.getByText('For a safe journey')).toBeInTheDocument()
      const logged = errSpy.mock.calls.flat().map(part => String(part && part.message ? part.message : part)).join(' ')
      expect(logged).toContain('Failed to fetch')
      errSpy.mockRestore()
    })

    it('a server English delete error stays in the log and the row stays', async () => {
      const server = 'Failed to delete Mass intention'
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
        const method = opts.method || 'GET'
        if (method === 'DELETE') return { ok: false, status: 500, json: async () => ({ error: server }) }
        return ok({ intentions: [ROW] })
      }))
      renderBook()
      fireEvent.click(await screen.findByRole('button', { name: copy(locale, 'mi.delete') }))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(DELETE_ORACLE[locale])
      expect(alert).not.toHaveTextContent(server)
      expect(screen.getByText('For a safe journey')).toBeInTheDocument()
      const logged = errSpy.mock.calls.flat().map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
      expect(logged).toContain(server)
      errSpy.mockRestore()
    })

    it('a Mass that cannot be confirmed says so and keeps the assignment', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        const u = String(url)
        if (/\/api\/calendar\/\d+/.test(u)) return httpError(500)
        if (u.includes('/api/calendar')) return ok([])
        return ok({ intentions: [] })
      }))
      renderBook('/mass-intentions?event=7&date=2026-09-13&compose=1')
      expect(await screen.findByText(copy(locale, 'mi.massHeldFailed'))).toBeInTheDocument()
      expect(screen.getByTestId('intention-mass-chrome')).toHaveTextContent(copy(locale, 'mi.massUnreachable'))
      expect(screen.getByLabelText(copy(locale, 'mi.assign'))).toHaveValue('7')
    })
  })
}
