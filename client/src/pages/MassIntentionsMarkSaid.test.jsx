// D-1 — the book shows the intentions the secretary chose, the day each
// one will be recorded (the scheduled Mass, editable), and does not mark
// anything until she confirms. Undo is offered on this visit only.
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { defaultSaidDate, intentionMayBeMarkedSaid } from '../utils/markSaid'
import MassIntentions from './MassIntentions'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const { en, es } = STRINGS
const SCHEDULED = {
  id: 7, intention: 'For the Rivera family', requested_by: 'Ana',
  mass_date: '2020-01-15', mass_title: 'Morning Mass', calendar_event_id: 40,
  status: 'scheduled', stipend: '12.50',
}
const LOOSE = {
  id: 8, intention: 'For a safe journey', requested_by: 'Ben',
  mass_date: null, mass_title: null, calendar_event_id: null,
  status: 'open', stipend: null,
}
const SAID = {
  id: 9, intention: 'For the departed', requested_by: 'Cara',
  mass_date: '2019-12-01', mass_title: 'Evening Mass', calendar_event_id: 41,
  status: 'fulfilled', stipend: '5.00',
}

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })))
}

function book() {
  return render(
    <MemoryRouter initialEntries={['/mass-intentions']}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Routes><Route path="/mass-intentions" element={<MassIntentions />} /></Routes>
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  stubMatchMedia()
})
afterEach(() => vi.unstubAllGlobals())

describe('mark-said selection', () => {
  it('offers the scheduled Mass day, requires confirmation, and never selects on its own', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const u = String(url)
      if (u.includes('/api/mass-intentions/bulk-mark-said')) {
        const body = JSON.parse(init.body)
        calls.push({ url: u, body })
        return ok({
          batch_id: body.request_id,
          replayed: false,
          marked: [{ id: '7', fulfilled_date: '2020-01-16' }],
          excluded: [{ id: '8', code: 'needs_date' }],
        })
      }
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [SCHEDULED, LOOSE, SAID] })
      return ok([])
    }))
    book()
    const rivera = en['mi.markSaidSelect'].replace('{name}', 'For the Rivera family')
    expect(await screen.findByLabelText(rivera)).toBeInTheDocument()
    expect(screen.queryByLabelText(en['mi.markSaidSelect'].replace('{name}', 'For the departed'))).toBeNull()
    expect(screen.queryByTestId('mi-mark-said-open')).toBeNull()
    fireEvent.click(screen.getByTestId('mi-past-filter'))
    expect(await screen.findByLabelText(rivera)).toBeInTheDocument()
    expect(screen.queryByTestId('mi-mark-said-open')).toBeNull()
    expect(calls).toHaveLength(0)

    fireEvent.click(screen.getByLabelText(rivera))
    fireEvent.click(screen.getByLabelText(en['mi.markSaidSelect'].replace('{name}', 'For a safe journey')))
    fireEvent.click(screen.getByTestId('mi-mark-said-open'))
    const panel = await screen.findByTestId('mi-mark-said-panel')
    expect(panel).toHaveTextContent('For the Rivera family')
    expect(panel).toHaveTextContent('For a safe journey')
    expect(panel).toHaveTextContent(en['mi.markSaidNoMass'])
    const dated = screen.getByLabelText(`${en['mi.markSaidDate']} For the Rivera family`)
    expect(dated).toHaveValue('2020-01-15')
    fireEvent.change(dated, { target: { value: '2020-01-16' } })
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByTestId('mi-mark-said-commit'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body.confirm).toBe(true)
    expect(calls[0].body.all).toBeUndefined()
    expect(calls[0].body.items).toEqual([
      { id: 7, fulfilled_date: '2020-01-16' },
      { id: 8, fulfilled_date: null },
    ])
    expect(calls[0].body.request_id).toMatch(/^[0-9a-f-]{36}$/)
    const result = await screen.findByTestId('mi-mark-said-result')
    expect(result).toHaveTextContent(en['mi.markSaidDone'].replace('{n}', '1'))
    expect(result).toHaveTextContent(en['mi.markSaidNeedsDate'])
    expect(screen.getByTestId('mi-mark-said-undo')).toBeInTheDocument()
  })

  it('undo asks before it puts the rows back, and a fresh visit does not offer it', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const u = String(url)
      if (u.includes('/undo')) {
        calls.push({ url: u, body: JSON.parse(init.body) })
        const batch = u.split('/bulk-mark-said/')[1].split('/undo')[0]
        return ok({ batch_id: batch, restored: [{ id: '7' }], already: false })
      }
      if (u.includes('/api/mass-intentions/bulk-mark-said')) {
        const body = JSON.parse(init.body)
        return ok({
          batch_id: body.request_id,
          marked: [{ id: '7', fulfilled_date: '2020-01-15' }],
          excluded: [],
        })
      }
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [SCHEDULED] })
      return ok([])
    }))
    const view = book()
    fireEvent.click(await screen.findByLabelText(en['mi.markSaidSelect'].replace('{name}', 'For the Rivera family')))
    fireEvent.click(screen.getByTestId('mi-mark-said-open'))
    fireEvent.click(screen.getByTestId('mi-mark-said-commit'))
    fireEvent.click(await screen.findByTestId('mi-mark-said-undo'))
    expect(calls).toHaveLength(0)
    expect(screen.getByTestId('mi-mark-said-undo-panel')).toHaveTextContent(en['mi.markSaidUndoBody'])
    fireEvent.click(screen.getByTestId('mi-mark-said-undo-commit'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body).toEqual({ confirm: true })
    expect(await screen.findByTestId('mi-mark-said-result')).toHaveTextContent(en['mi.markSaidUndone'])
    view.unmount()
    book()
    await screen.findByText('For the Rivera family')
    expect(screen.queryByTestId('mi-mark-said-undo')).toBeNull()
  })

  it('speaks Spanish on the confirmation, and the new keys exist in both languages', async () => {
    for (const key of Object.keys(en).filter(k => k.startsWith('mi.markSaid'))) {
      expect(es[key], key).toBeTruthy()
      expect(es[key], key).not.toBe(en[key])
    }
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/api/mass-intentions')) return ok({ intentions: [SCHEDULED, LOOSE] })
      return ok([])
    }))
    book()
    fireEvent.click(await screen.findByLabelText(es['mi.markSaidSelect'].replace('{name}', 'For the Rivera family')))
    fireEvent.click(screen.getByTestId('mi-mark-said-open'))
    expect(await screen.findByTestId('mi-mark-said-panel')).toHaveTextContent(es['mi.markSaidTitle'])
    expect(screen.getByTestId('mi-mark-said-panel')).toHaveTextContent(es['mi.markSaidBody'])
  })
})

describe('mark-said day defaults', () => {
  it('uses the linked Mass day and refuses fulfilled or unlinked rows', () => {
    expect(defaultSaidDate(SCHEDULED)).toBe('2020-01-15')
    expect(defaultSaidDate(LOOSE)).toBe('')
    expect(intentionMayBeMarkedSaid(SAID)).toBe(false)
    expect(intentionMayBeMarkedSaid(LOOSE)).toBe(true)
    expect(intentionMayBeMarkedSaid({ status: 'cancelled' })).toBe(false)
    expect(intentionMayBeMarkedSaid({ status: 'scheduled', entered_history: true })).toBe(false)
  })
})

const PROTECTED = {
  id: 10, intention: 'For the parish record', requested_by: 'Ada',
  mass_date: '2020-01-20', mass_title: 'Parish Mass', calendar_event_id: 42,
  status: 'scheduled', stipend: null, entered_history: true,
}
describe('R348 mark-said answers', () => {
  it('R348-1 does not offer a row the record already protects', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/api/mass-intentions')) return ok({ intentions: [PROTECTED, SCHEDULED] })
      return ok([])
    }))
    book()
    expect(await screen.findByLabelText(en['mi.markSaidSelect'].replace('{name}', 'For the Rivera family'))).toBeInTheDocument()
    expect(screen.queryByLabelText(en['mi.markSaidSelect'].replace('{name}', 'For the parish record'))).toBeNull()
  })

  it('R348-4 does not treat a malformed mark answer as recorded', async () => {
    const shapes = [
      () => ({ batch_id: 'bad', marked: [{}], excluded: [] }),
      req => ({ batch_id: req.request_id, marked: [null], excluded: [] }),
      req => ({ batch_id: req.request_id, marked: [{ id: '7' }], excluded: [] }),
      req => ({ batch_id: req.request_id, marked: [{ id: '7', fulfilled_date: '2020-02-31' }], excluded: [] }),
      req => ({ batch_id: req.request_id, marked: [{ id: '7', fulfilled_date: '2020-01-16' }, { id: '7', fulfilled_date: '2020-01-16' }], excluded: [] }),
      req => ({ batch_id: req.request_id, marked: [{ id: '99', fulfilled_date: '2020-01-16' }], excluded: [] }),
      req => ({ batch_id: req.request_id, marked: [], excluded: [] }),
      req => ({ batch_id: req.request_id, marked: [{ id: 7, fulfilled_date: '2020-01-16' }], excluded: [{ id: '8', code: 'needs_date' }] }),
      () => ({ batch_id: '22222222-2222-4222-8222-222222222222', marked: [{ id: '7', fulfilled_date: '2020-01-16' }], excluded: [{ id: '8', code: 'needs_date' }] }),
    ]
    for (const shape of shapes) {
      const calls = []
      vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
        const u = String(url)
        if (u.includes('/api/mass-intentions/bulk-mark-said')) {
          const body = JSON.parse(init.body)
          calls.push({ url: u, body })
          return ok(shape(body))
        }
        if (u.includes('/api/mass-intentions')) return ok({ intentions: [SCHEDULED, LOOSE] })
        return ok([])
      }))
      const view = book()
      fireEvent.click(await screen.findByLabelText(en['mi.markSaidSelect'].replace('{name}', 'For the Rivera family')))
      fireEvent.click(screen.getByLabelText(en['mi.markSaidSelect'].replace('{name}', 'For a safe journey')))
      fireEvent.click(screen.getByTestId('mi-mark-said-open'))
      fireEvent.click(screen.getByTestId('mi-mark-said-commit'))
      expect(await screen.findByTestId('mi-mark-said-panel')).toHaveTextContent(en['mi.markSaidUnreadable'])
      expect(screen.queryByTestId('mi-mark-said-result')).toBeNull()
      expect(screen.getByTestId('mi-mark-said-commit')).not.toBeDisabled()
      const requestId = calls[0].body.request_id
      fireEvent.click(screen.getByTestId('mi-mark-said-retry'))
      await waitFor(() => expect(calls).toHaveLength(2))
      expect(calls[1].body.request_id).toBe(requestId)
      view.unmount()
    }
  })

  it('R348-4 accepts a server-shaped mark and refuses a malformed undo', async () => {
    const calls = []
    let undoShape = () => ({ batch_id: 'bad', restored: [null], already: false })
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const u = String(url)
      if (u.includes('/undo')) {
        calls.push({ url: u, body: JSON.parse(init.body) })
        const batch = u.split('/bulk-mark-said/')[1].split('/undo')[0]
        return ok(undoShape(batch))
      }
      if (u.includes('/api/mass-intentions/bulk-mark-said')) {
        const body = JSON.parse(init.body)
        return ok({
          batch_id: body.request_id,
          marked: [{ id: '7', fulfilled_date: '2020-01-15' }],
          excluded: [],
        })
      }
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [SCHEDULED] })
      return ok([])
    }))
    book()
    fireEvent.click(await screen.findByLabelText(en['mi.markSaidSelect'].replace('{name}', 'For the Rivera family')))
    fireEvent.click(screen.getByTestId('mi-mark-said-open'))
    fireEvent.click(screen.getByTestId('mi-mark-said-commit'))
    expect(await screen.findByTestId('mi-mark-said-result')).toHaveTextContent(en['mi.markSaidDone'].replace('{n}', '1'))
    const badUndos = [
      () => ({ batch_id: 'bad', restored: [{ id: '7' }], already: false }),
      batch => ({ batch_id: batch, restored: [null], already: false }),
      batch => ({ batch_id: batch, restored: [{}], already: false }),
      batch => ({ batch_id: batch, restored: [], already: false }),
      batch => ({ batch_id: batch, restored: [{ id: '99' }], already: false }),
      batch => ({ batch_id: batch, restored: [{ id: '7' }, { id: '7' }], already: false }),
      () => ({ batch_id: '22222222-2222-4222-8222-222222222222', restored: [{ id: '7' }], already: false }),
    ]
    fireEvent.click(screen.getByTestId('mi-mark-said-undo'))
    for (const shape of badUndos) {
      undoShape = shape
      fireEvent.click(screen.getByTestId('mi-mark-said-undo-commit'))
      expect(await screen.findByTestId('mi-mark-said-undo-panel')).toHaveTextContent(en['mi.markSaidUnreadable'])
      expect(screen.getByTestId('mi-mark-said-result')).not.toHaveTextContent(en['mi.markSaidUndone'])
      expect(screen.getByTestId('mi-mark-said-undo-commit')).not.toBeDisabled()
    }
    undoShape = batch => ({ batch_id: batch, restored: [{ id: '7' }], already: false })
    fireEvent.click(screen.getByTestId('mi-mark-said-undo-commit'))
    expect(await screen.findByTestId('mi-mark-said-result')).toHaveTextContent(en['mi.markSaidUndone'])
    expect(calls.at(-1).body).toEqual({ confirm: true })
  })
})
