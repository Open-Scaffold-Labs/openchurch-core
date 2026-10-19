// Stage 6 — the whole audit page follows the session language, and login
// lifecycle rows say what happened in that language. Rows written before
// lifecycle metadata existed keep their stored wording.
import { render, screen, within, fireEvent } from '@testing-library/react'
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
const NOW = new Date().toISOString()

// An ordinary update written before client keys were stripped: its metadata
// claims a closure. Only the server-written action may label a row.
const FORGED = { id: 9, created_at: NOW, user_name: 'Sacristan', user_email: 'sacristan@parish.test', action: 'update',
  entity_type: 'user', entity_id: '7', summary: 'Updated user #7', metadata: { op: 'close', via: 'admin', already: true }, status_code: 200 }
const FORGED_ALL = [
  FORGED,
  { ...FORGED, id: 10, entity_id: '8', summary: 'Updated user: Role change', metadata: { op: 'deactivate', via: 'self' } },
  { ...FORGED, id: 11, entity_id: '9', summary: 'Created user: Synthetic Nine', action: 'create', metadata: { op: 'reactivate', via: 'admin', already: true } },
]

const ROWS = [
  { id: 3, created_at: NOW, user_name: 'Sacristan', user_email: 'sacristan@parish.test', action: 'close',
    entity_type: 'user', entity_id: '5', summary: 'Closed login #5', metadata: { via: 'admin' }, status_code: 200 },
  { id: 2, created_at: NOW, user_name: 'Sacristan', user_email: 'sacristan@parish.test', action: 'deactivate',
    entity_type: 'user', entity_id: '6', summary: 'Turned login off #6 (already off)', metadata: { via: 'admin', already: true }, status_code: 200 },
  // As the old middleware stored a closure: no lifecycle metadata.
  { id: 1, created_at: NOW, user_name: 'Sacristan', user_email: 'sacristan@parish.test', action: 'create',
    entity_type: 'user', entity_id: '4', summary: 'Created user', metadata: {}, status_code: 200 },
]

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function stub(body) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (!u.includes('/api/audit-log') || u.includes('/export')) return ok({})
    return ok(body)
  }))
}

function mount(locale, path = '/audit') {
  localStorage.setItem('ochr_locale', locale)
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <ToastProvider>
          <Audit />
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale') })
afterEach(() => { localStorage.removeItem('ochr_locale') })

// Every key the page renders in the rows view, chrome included.
const PAGE_KEYS = [
  'audit.title', 'audit.subtitle', 'audit.export',
  'audit.filterAction', 'audit.filterType', 'audit.filterSince', 'audit.filterUntil',
  'audit.colWhen', 'audit.colWho', 'audit.colWhat', 'audit.colStatus',
]

describe('audit page language', () => {
  it.each(['en', 'es'])('%s: chrome, filters, columns and footer follow the session language', async (locale) => {
    const S = STRINGS[locale]
    stub({ rows: ROWS, total: 3, hasMore: true })
    mount(locale)
    await screen.findByText(S['audit.life.close'].replace('{id}', '5'))
    for (const k of PAGE_KEYS) expect(screen.getAllByText(S[k]).length, k).toBeGreaterThan(0)
    expect(screen.getByRole('combobox', { name: S['audit.filterActionAria'] })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: S['audit.filterTypeAria'] })).toBeInTheDocument()
    expect(screen.getByLabelText(S['audit.filterSinceAria'])).toBeInTheDocument()
    expect(screen.getByLabelText(S['audit.filterUntilAria'])).toBeInTheDocument()
    expect(screen.getByRole('option', { name: S['audit.action.all'] })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: S['audit.type.mass_intention'] })).toBeInTheDocument()
    expect(screen.getByText(S['audit.showing'].replace('{shown}', '3').replace('{total}', '3'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: S['audit.loadMore'] })).toBeInTheDocument()
    expect(screen.getAllByText(S['audit.badge.close']).length).toBe(1)
    expect(screen.getAllByText(S['audit.badge.deactivate']).length).toBe(1)
    expect(screen.getByRole('option', { name: S['audit.action.close'] })).toBeInTheDocument()
  })

  it('es: no English chrome is left on the rows view', async () => {
    stub({ rows: ROWS, total: 3, hasMore: true })
    mount('es')
    await screen.findByText(es['audit.life.close'].replace('{id}', '5'))
    for (const k of [...PAGE_KEYS, 'audit.loadMore', 'audit.action.all', 'audit.type.all', 'audit.badge.close', 'audit.badge.deactivate']) {
      if (en[k] === es[k]) continue
      expect(screen.queryByText(en[k]), k).not.toBeInTheDocument()
    }
    expect(screen.queryByText(/ago$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument()
  })

  it.each(['en', 'es'])('%s: empty and filtered-empty states follow the session language', async (locale) => {
    const S = STRINGS[locale]
    stub({ rows: [], total: 0, hasMore: false })
    mount(locale)
    expect(await screen.findByText(S['audit.emptyTitle'])).toBeInTheDocument()
    expect(screen.getByText(S['audit.emptyBody'])).toBeInTheDocument()
  })

  it.each(['en', 'es'])('%s: a filtered empty view and the record-scope chip', async (locale) => {
    const S = STRINGS[locale]
    stub({ rows: [], total: 0, hasMore: false })
    mount(locale, '/audit?entity_type=client&entity_id=42')
    expect(await screen.findByText(S['audit.emptyFilteredTitle'])).toBeInTheDocument()
    expect(screen.getByText(S['audit.emptyFilteredBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: S['audit.clearFilters'] })).toBeInTheDocument()
    expect(screen.getByText(S['audit.scopedTo'].replace('{type}', S['audit.type.client']).replace('{id}', '42'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: S['audit.clearScope'] })).toBeInTheDocument()
  })
})

describe('login lifecycle rows', () => {
  it.each(['en', 'es'])('%s: closure and repeat turn-off read as what happened', async (locale) => {
    const S = STRINGS[locale]
    stub({ rows: ROWS, total: 3, hasMore: false })
    mount(locale)
    expect(await screen.findByText(S['audit.life.close'].replace('{id}', '5'))).toBeInTheDocument()
    expect(screen.getByText(`${S['audit.life.deactivate'].replace('{id}', '6')} ${S['audit.life.already.deactivate']}`)).toBeInTheDocument()
  })

  it.each(['en', 'es'])('%s: an older update whose metadata claims a closure shows as the update it was', async (locale) => {
    const S = STRINGS[locale]
    stub({ rows: [FORGED], total: 1, hasMore: false })
    mount(locale)
    const row = (await screen.findByText('Updated user #7')).closest('tr')
    expect(within(row).getByText(S['audit.badge.update'])).toBeInTheDocument()
    expect(within(row).queryByText(S['audit.life.close'].replace('{id}', '7'), { exact: false })).not.toBeInTheDocument()
    expect(within(row).queryByText(S['audit.life.already.close'], { exact: false })).not.toBeInTheDocument()
  })

  it.each(['en', 'es'])('%s: older rows claiming close / deactivate / reactivate in metadata keep their stored summaries', async (locale) => {
    const S = STRINGS[locale]
    stub({ rows: FORGED_ALL, total: 3, hasMore: false })
    mount(locale)
    for (const r of FORGED_ALL) {
      const row = (await screen.findByText(r.summary)).closest('tr')
      expect(within(row).getByText(S[`audit.badge.${r.action}`])).toBeInTheDocument()
    }
    for (const k of ['audit.life.close', 'audit.life.deactivate', 'audit.life.deactivateSelf', 'audit.life.reactivate']) {
      for (const id of ['7', '8', '9']) expect(screen.queryByText(S[k].replace('{id}', id), { exact: false })).not.toBeInTheDocument()
    }
    for (const k of ['audit.life.already.close', 'audit.life.already.deactivate', 'audit.life.already.reactivate']) {
      expect(screen.queryByText(S[k], { exact: false })).not.toBeInTheDocument()
    }
  })

  it.each(['en', 'es'])('%s: legitimate rows for each lifecycle action render in the session language', async (locale) => {
    const S = STRINGS[locale]
    const base = { created_at: NOW, user_name: 'Sacristan', user_email: 's@parish.test', entity_type: 'user', status_code: 200 }
    stub({ rows: [
      { ...base, id: 21, action: 'close', entity_id: '21', summary: 'Closed own login #21', metadata: { via: 'self' } },
      { ...base, id: 22, action: 'deactivate', entity_id: '22', summary: 'Turned own login off #22', metadata: { via: 'self' } },
      { ...base, id: 23, action: 'reactivate', entity_id: '23', summary: 'Turned login back on #23 (already on)', metadata: { via: 'admin', already: true } },
      { ...base, id: 24, action: 'close', entity_id: '24', summary: 'Closed login #24', metadata: { via: 'legacy-delete' } },
    ], total: 4, hasMore: false })
    mount(locale)
    expect(await screen.findByText(S['audit.life.closeSelf'].replace('{id}', '21'))).toBeInTheDocument()
    expect(screen.getByText(S['audit.life.deactivateSelf'].replace('{id}', '22'))).toBeInTheDocument()
    expect(screen.getByText(`${S['audit.life.reactivate'].replace('{id}', '23')} ${S['audit.life.already.reactivate']}`)).toBeInTheDocument()
    expect(screen.getByText(S['audit.life.close'].replace('{id}', '24'))).toBeInTheDocument()
  })

  it.each(['en', 'es'])('%s: lifecycle action filters are offered and sent as the server action', async (locale) => {
    const S = STRINGS[locale]
    stub({ rows: ROWS, total: 3, hasMore: false })
    mount(locale)
    await screen.findByText(S['audit.life.close'].replace('{id}', '5'))
    const select = screen.getByRole('combobox', { name: S['audit.filterActionAria'] })
    for (const a of ['close', 'deactivate', 'reactivate']) {
      expect(within(select).getByRole('option', { name: S[`audit.action.${a}`] })).toHaveValue(a)
      fireEvent.change(select, { target: { value: a } })
      await vi.waitFor(() => {
        const urls = fetch.mock.calls.map((c) => String(c[0]))
        expect(urls.some((u) => u.includes('/api/audit-log?') && u.includes(`action=${a}`))).toBe(true)
      })
    }
  })

  it.each(['en', 'es'])('%s: member minimization and organization HOLD rows read as what happened', async (locale) => {
    const S = STRINGS[locale]
    const base = { created_at: NOW, user_name: 'Sacristan', user_email: 's@parish.test', status_code: 200 }
    stub({ rows: [
      { ...base, id: 31, action: 'deidentify', entity_type: 'client', entity_id: '31', summary: 'Minimized member contact details #31', metadata: {} },
      { ...base, id: 32, action: 'deidentify', entity_type: 'client', entity_id: '32', summary: 'Minimized member contact details #32 (already minimized)', metadata: { already: true } },
      { ...base, id: 33, action: 'hold', entity_type: 'organization', entity_id: '7', summary: 'Placed organization on hold #7', metadata: {} },
      { ...base, id: 36, action: 'hold', entity_type: 'organization', entity_id: '8', summary: 'x', metadata: { cleanup_complete: false } },
      { ...base, id: 37, action: 'hold', entity_type: 'organization', entity_id: '8', summary: 'x', metadata: { already: true, cleanup_complete: true, via: 'operator' } },
      // Older ordinary rows whose metadata copies a client body that named a stewardship action.
      { ...base, id: 34, action: 'create', entity_type: 'client', entity_id: '34', summary: 'Created client: Synthetic Body', metadata: { action: 'deidentify', op: 'deidentify' } },
      { ...base, id: 35, action: 'update', entity_type: 'organization', entity_id: '7', summary: 'Updated organization #7', metadata: { action: 'hold', already: true } },
    ], total: 7, hasMore: false })
    mount(locale)
    expect(await screen.findByText(S['audit.stew.deidentify'].replace('{id}', '31'))).toBeInTheDocument()
    expect(screen.getByText(`${S['audit.stew.hold'].replace('{id}', '8')} ${S['audit.stew.incomplete.hold']}`)).toBeInTheDocument()
    expect(screen.getByText(`${S['audit.stew.hold'].replace('{id}', '8')} ${S['audit.stew.already.hold']} ${S['audit.stew.completed.hold']}`)).toBeInTheDocument()
    expect(screen.getByText(`${S['audit.stew.deidentify'].replace('{id}', '32')} ${S['audit.stew.already.deidentify']}`)).toBeInTheDocument()
    expect(screen.getByText(S['audit.stew.hold'].replace('{id}', '7'))).toBeInTheDocument()
    expect(screen.getAllByText(S['audit.badge.deidentify'])).toHaveLength(2)
    expect(screen.getAllByText(S['audit.badge.hold'])).toHaveLength(3)
    expect(within(screen.getByText('Created client: Synthetic Body').closest('tr')).getByText(S['audit.badge.create'])).toBeInTheDocument()
    expect(within(screen.getByText('Updated organization #7').closest('tr')).getByText(S['audit.badge.update'])).toBeInTheDocument()
    const select = screen.getByRole('combobox', { name: S['audit.filterActionAria'] })
    expect(within(select).getByRole('option', { name: S['audit.action.deidentify'] })).toHaveValue('deidentify')
    expect(within(select).getByRole('option', { name: S['audit.action.hold'] })).toHaveValue('hold')
  })

  it('a row stored before lifecycle metadata keeps its original text', async () => {
    stub({ rows: ROWS, total: 3, hasMore: false })
    mount('es')
    const row = (await screen.findByText('Created user')).closest('tr')
    expect(within(row).getByText(es['audit.badge.create'])).toBeInTheDocument()
  })
})
