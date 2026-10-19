// APPLE-NOTIFICATIONS-PAGE-L1-01 — the admin notifications page in a
// real English session and a real Spanish session. Chrome, empty copy,
// known status words, and the failed-read sentence come from the page
// dictionary. The type token and the address stay server data.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import Notifications from './Notifications'

const authState = vi.hoisted(() => ({ locale: 'en', role: 'admin' }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      name: 'Secretary',
      role: authState.role,
      organization: { id: 1, name: 'St Test', locale: authState.locale, tradition: 'catholic' },
    },
    token: 't',
    loading: false,
  }),
}))

const ES = {
  title: 'Notificaciones',
  subtitle: 'Lo que está por enviarse, y lo que se envió hace poco.',
  upcoming: 'Próximos',
  recent: 'Recientes',
  emptyQueued: 'Nada en espera por ahora.',
  emptySent: 'Aún no se ha enviado nada.',
  adminsOnly: 'Solo administradores',
  pending: 'Pendiente',
  delivered: 'Entregado',
  loadFailed: 'No se pudo leer esta lista — no se perdió nada. Inténtelo de nuevo, por favor.',
}

const EN = {
  title: 'Notifications',
  subtitle: "What's queued to go out, and what recently did.",
  upcoming: 'Upcoming',
  recent: 'Recent',
  emptyQueued: 'Nothing queued right now.',
  emptySent: 'Nothing sent yet.',
  pending: 'Pending',
  delivered: 'Delivered',
  loadFailed: "That list didn't load — nothing was lost. Please try again.",
}

const ROW_TIME = '2026-09-01T15:00:00Z'
const SCHEDULED = [{
  id: 's1',
  notification_type: 'event_reminder',
  recipient_email: 'a@x.com',
  status: 'pending',
  send_at: ROW_TIME,
}]
const LOG = [{
  id: 'l1',
  notification_type: 'task_assigned',
  recipient_email: 'b@x.com',
  status: 'delivered',
  created_at: ROW_TIME,
}]
const UNKNOWN = [{
  id: 'u1',
  notification_type: 'custom_token',
  recipient_email: 'c@x.com',
  status: 'webhook_weird',
  send_at: ROW_TIME,
}]

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const httpError = (status) => ({ ok: false, status, json: async () => ({ error: 'Failed to load' }) })

function mount() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <Notifications />
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  authState.locale = 'en'
  authState.role = 'admin'
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.unstubAllGlobals()
})

describe('APPLE-NOTIFICATIONS-PAGE-L1-01 source', () => {
  it('the page no longer hard-codes the English chrome', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Notifications.jsx'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/>Notifications</)
    expect(code).not.toMatch(/What's queued to go out/)
    expect(code).not.toMatch(/Nothing queued right now/)
    expect(code).not.toMatch(/Nothing sent yet/)
    expect(code).not.toMatch(/Admins only/)
    expect(code).not.toMatch(/Failed \(\$\{res\.status\}\)/)
  })
})

for (const locale of ['en', 'es']) {
  const copy = locale === 'es' ? ES : EN
  describe(`APPLE-NOTIFICATIONS-PAGE-L1-01 rendered ${locale}`, () => {
    beforeEach(() => {
      authState.locale = locale
    })

    it('names the page, the two panels, and the empty sentences', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ok({ scheduled: [], log: [] })))
      mount()
      expect(await screen.findByRole('heading', { level: 1, name: copy.title })).toBeInTheDocument()
      expect(screen.getByText(copy.subtitle)).toBeInTheDocument()
      expect(screen.getByRole('region', { name: copy.upcoming })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: copy.recent })).toBeInTheDocument()
      expect(screen.getByText(copy.emptyQueued)).toBeInTheDocument()
      expect(screen.getByText(copy.emptySent)).toBeInTheDocument()
    })

    it('every known status badge uses that locale, including sent', async () => {
      const rows = [
        ['sent', 'Sent', 'Enviado'],
        ['delivered', 'Delivered', 'Entregado'],
        ['stubbed', 'Stubbed', 'Simulado'],
        ['skipped', 'Skipped', 'Omitido'],
        ['suppressed', 'Suppressed', 'Retenido'],
        ['failed', 'Failed', 'Falló'],
        ['bounced', 'Bounced', 'Rebotó'],
        ['complained', 'Complained', 'Queja'],
        ['pending', 'Pending', 'Pendiente'],
      ].map(([status], i) => ({
        id: `st${i}`,
        notification_type: 'task_assigned',
        recipient_email: 'd@x.com',
        status,
        created_at: ROW_TIME,
      }))
      vi.stubGlobal('fetch', vi.fn(async (url) => (
        String(url).includes('/scheduled') ? ok({ scheduled: [] }) : ok({ log: rows })
      )))
      mount()
      const words = [
        ['Sent', 'Enviado'],
        ['Delivered', 'Entregado'],
        ['Stubbed', 'Simulado'],
        ['Skipped', 'Omitido'],
        ['Suppressed', 'Retenido'],
        ['Failed', 'Falló'],
        ['Bounced', 'Rebotó'],
        ['Complained', 'Queja'],
        ['Pending', 'Pendiente'],
      ]
      await screen.findByText(locale === 'es' ? 'Enviado' : 'Sent')
      for (const [en, esWord] of words) {
        const shown = locale === 'es' ? esWord : en
        const other = locale === 'es' ? en : esWord
        expect(screen.getByText(shown)).toBeInTheDocument()
        expect(screen.queryByText(other)).not.toBeInTheDocument()
      }
    })

    it('translates known statuses and keeps the type and address as data', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url) => (
        String(url).includes('/scheduled') ? ok({ scheduled: SCHEDULED }) : ok({ log: LOG })
      )))
      mount()
      expect(await screen.findByText(/event reminder/i)).toBeInTheDocument()
      expect(screen.getByText('a@x.com')).toBeInTheDocument()
      expect(screen.getByText('b@x.com')).toBeInTheDocument()
      expect(screen.getByText(copy.pending)).toBeInTheDocument()
      expect(screen.getByText(copy.delivered)).toBeInTheDocument()
      const when = new Date(ROW_TIME).toLocaleString(locale === 'es' ? 'es' : 'en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
      expect(screen.getAllByText(when).length).toBeGreaterThan(0)
      if (locale === 'es') {
        expect(screen.queryByText('Pending')).not.toBeInTheDocument()
        expect(screen.queryByText('Delivered')).not.toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: 'Notifications' })).not.toBeInTheDocument()
      }
    })

    it('leaves an unknown status as the server token', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url) => (
        String(url).includes('/scheduled') ? ok({ scheduled: UNKNOWN }) : ok({ log: [] })
      )))
      mount()
      expect(await screen.findByText('webhook_weird')).toBeInTheDocument()
      expect(screen.getByText('c@x.com')).toBeInTheDocument()
      expect(screen.getByText(copy.emptySent)).toBeInTheDocument()
    })

    it('a rejected fetch shows the book sentence, not Failed to fetch', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).includes('/scheduled')) throw new TypeError('Failed to fetch')
        return ok({ log: LOG })
      }))
      mount()
      const alert = await screen.findByRole('status')
      if (locale === 'es') {
        expect(alert).toHaveTextContent('No se pudo leer esta lista — no se perdió nada. Inténtelo de nuevo, por favor.')
      } else {
        expect(alert).toHaveTextContent(copy.loadFailed)
      }
      expect(alert).not.toHaveTextContent('Failed to fetch')
      expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument()
      expect(screen.queryByText(copy.emptyQueued)).not.toBeInTheDocument()
      expect(screen.getByText('b@x.com')).toBeInTheDocument()
      const logged = errSpy.mock.calls.flat().map(part => (
        part instanceof Error ? part.message : (typeof part === 'string' ? part : JSON.stringify(part))
      )).join(' ')
      expect(logged).toContain('Failed to fetch')
      errSpy.mockRestore()
    })

    it('a body that will not parse shows the book sentence, not the parser text', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).includes('/scheduled')) {
          return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }
        }
        return ok({ log: LOG })
      }))
      mount()
      const alert = await screen.findByRole('status')
      if (locale === 'es') {
        expect(alert).toHaveTextContent('No se pudo leer esta lista — no se perdió nada. Inténtelo de nuevo, por favor.')
      } else {
        expect(alert).toHaveTextContent(copy.loadFailed)
      }
      expect(alert).not.toHaveTextContent('Unexpected token')
      expect(screen.queryByText(/Unexpected token/)).not.toBeInTheDocument()
      expect(screen.getByText('b@x.com')).toBeInTheDocument()
      const logged = errSpy.mock.calls.flat().map(part => (
        part instanceof Error ? part.message : (typeof part === 'string' ? part : JSON.stringify(part))
      )).join(' ')
      expect(logged).toContain('Unexpected token')
      errSpy.mockRestore()
    })

    it('a null JSON body shows the book sentence, not a TypeError', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).includes('/scheduled')) return { ok: true, status: 200, json: async () => null }
        return ok({ log: LOG })
      }))
      mount()
      const alert = await screen.findByRole('status')
      if (locale === 'es') {
        expect(alert).toHaveTextContent('No se pudo leer esta lista — no se perdió nada. Inténtelo de nuevo, por favor.')
      } else {
        expect(alert).toHaveTextContent(copy.loadFailed)
      }
      expect(alert).not.toHaveTextContent('Cannot read properties of null')
      expect(alert).not.toHaveTextContent('TypeError')
      expect(screen.queryByText(/Cannot read properties of null/)).not.toBeInTheDocument()
      expect(screen.queryByText(copy.emptyQueued)).not.toBeInTheDocument()
      expect(screen.getByText('b@x.com')).toBeInTheDocument()
      const logged = errSpy.mock.calls.flat().map(part => (
        part instanceof Error ? part.message : (typeof part === 'string' ? part : JSON.stringify(part))
      )).join(' ')
      expect(logged).toContain('null')
      errSpy.mockRestore()
    })

    it('a null panel field shows the book sentence, not an empty list', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).includes('/scheduled')) return { ok: true, status: 200, json: async () => ({ scheduled: null }) }
        return ok({ log: LOG })
      }))
      mount()
      const alert = await screen.findByRole('status')
      if (locale === 'es') {
        expect(alert).toHaveTextContent('No se pudo leer esta lista — no se perdió nada. Inténtelo de nuevo, por favor.')
      } else {
        expect(alert).toHaveTextContent(copy.loadFailed)
      }
      expect(screen.queryByText(copy.emptyQueued)).not.toBeInTheDocument()
      expect(screen.getByText('(—)')).toBeInTheDocument()
      expect(screen.getByText('b@x.com')).toBeInTheDocument()
      const logged = errSpy.mock.calls.flat().map(part => (
        part instanceof Error ? part.message : (typeof part === 'string' ? part : JSON.stringify(part))
      )).join(' ')
      expect(logged).toContain('[Notifications] read malformed')
      errSpy.mockRestore()
    })

    it('a missing panel field shows the book sentence, not an empty list', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).includes('/scheduled')) return { ok: true, status: 200, json: async () => ({}) }
        return ok({ log: LOG })
      }))
      mount()
      const alert = await screen.findByRole('status')
      if (locale === 'es') {
        expect(alert).toHaveTextContent('No se pudo leer esta lista — no se perdió nada. Inténtelo de nuevo, por favor.')
      } else {
        expect(alert).toHaveTextContent(copy.loadFailed)
      }
      expect(screen.queryByText(copy.emptyQueued)).not.toBeInTheDocument()
      expect(screen.getByText('b@x.com')).toBeInTheDocument()
    })

    it('a non-array panel field shows the book sentence, not an empty list', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).includes('/scheduled')) return { ok: true, status: 200, json: async () => ({ scheduled: { nope: true } }) }
        return ok({ log: LOG })
      }))
      mount()
      const alert = await screen.findByRole('status')
      if (locale === 'es') {
        expect(alert).toHaveTextContent('No se pudo leer esta lista — no se perdió nada. Inténtelo de nuevo, por favor.')
      } else {
        expect(alert).toHaveTextContent(copy.loadFailed)
      }
      expect(screen.queryByText(copy.emptyQueued)).not.toBeInTheDocument()
      expect(screen.getByText('b@x.com')).toBeInTheDocument()
    })

    it('a JSON array body shows the book sentence, not an empty list', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).includes('/scheduled')) return { ok: true, status: 200, json: async () => [] }
        return ok({ log: LOG })
      }))
      mount()
      const alert = await screen.findByRole('status')
      if (locale === 'es') {
        expect(alert).toHaveTextContent('No se pudo leer esta lista — no se perdió nada. Inténtelo de nuevo, por favor.')
      } else {
        expect(alert).toHaveTextContent(copy.loadFailed)
      }
      expect(screen.queryByText(copy.emptyQueued)).not.toBeInTheDocument()
      expect(screen.getByText('b@x.com')).toBeInTheDocument()
      const logged = errSpy.mock.calls.flat().map(part => (
        part instanceof Error ? part.message : (typeof part === 'string' ? part : JSON.stringify(part))
      )).join(' ')
      expect(logged).toContain('[Notifications] read malformed')
      expect(logged).toContain('[]')
      errSpy.mockRestore()
    })

    it('a refused read shows the book sentence, not the status code', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async (url) => (
        String(url).includes('/scheduled') ? httpError(500) : ok({ log: LOG })
      )))
      mount()
      await waitFor(() => expect(screen.getByText(copy.loadFailed, { exact: false })).toBeInTheDocument())
      expect(screen.queryByText(/Failed \(500\)/)).not.toBeInTheDocument()
      expect(screen.queryByText(copy.emptyQueued)).not.toBeInTheDocument()
      expect(screen.getByText('b@x.com')).toBeInTheDocument()
      const logged = errSpy.mock.calls.flat().map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
      expect(logged).toContain('500')
      errSpy.mockRestore()
    })
  })
}

describe('APPLE-NOTIFICATIONS-PAGE-L1-01 admins only', () => {
  it('a non-admin Spanish session does not see the English gate', async () => {
    authState.locale = 'es'
    authState.role = 'staff'
    vi.stubGlobal('fetch', vi.fn(async () => ok({ scheduled: [], log: [] })))
    mount()
    expect(await screen.findByText(ES.adminsOnly)).toBeInTheDocument()
    expect(screen.queryByText('Admins only')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: ES.title })).not.toBeInTheDocument()
  })
})
