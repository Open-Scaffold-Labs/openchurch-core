// Saint SP-181..SP-185 (2026-10-25 noon probe) + #285 F6 (José, 2026-10-25).
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import MassIntentions from './MassIntentions'
import MassIntentionAssign from '../components/MassIntentionAssign'
import AfterMassIntentionsPrompt from '../components/AfterMassIntentionsPrompt'
import { IntentionLine } from './Schedule'
import { parishTodayIso } from '../utils/markSaid'

const auth = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: auth.role, organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic', timezone: 'America/Los_Angeles' } },
    token: 't', loading: false, canWrite: auth.role !== 'viewer', isAdmin: auth.role === 'admin',
  }),
}))

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const { en, es } = STRINGS
const base = { requested_by: 'Synthetic family', requested_by_client_id: null, note: null }
const FULFILLED = { ...base, id: 2, intention: 'Fulfilled row', mass_date: '2032-04-01', mass_title: 'Sunday Mass', mass_time: '10:00', calendar_event_id: 9, stipend: '10.00', status: 'fulfilled' }
const UNKNOWN = { ...base, id: 3, intention: 'Legacy fulfilled', mass_date: null, mass_title: null, stipend: null, status: 'fulfilled' }

const wrap = (node, entry = '/') => render(
  <MemoryRouter initialEntries={[entry]}><LocaleProvider><ToastProvider><ConfirmProvider>{node}</ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)
const book = (entry = '/mass-intentions') => wrap(<Routes><Route path="/mass-intentions" element={<MassIntentions />} /></Routes>, entry)

let calls
beforeEach(() => {
  auth.role = 'admin'
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/api/mass-intentions?')) return ok({ intentions: [FULFILLED, UNKNOWN] })
    return ok([])
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('copy', () => {
  it('EN and ES exist and differ for every new key', () => {
    for (const k of ['mi.saidOn', 'mi.saidDateUnknown', 'mi.fulfilledOfferingLocked', 'mi.offeringLockedNote', 'sched.saidBadge', 'sched.intentionsAll', 'dash.miPromptTitle', 'dash.miPromptBody', 'dash.miPromptAction']) {
      expect(en[k], k).toBeTruthy(); expect(es[k], k).toBeTruthy(); expect(es[k], k).not.toBe(en[k])
    }
  })
  it('SP-181: Help says the past-scheduled filter includes today\'s Masses once begun (EN+ES)', () => {
    expect(en['help.miFulfillHowBody']).toMatch(/includes today's Masses once their start time has passed/)
    expect(es['help.miFulfillHowBody']).toMatch(/incluye las Misas de hoy/)
  })
})

describe('SP-182 — no Release beside a fulfilled intention', () => {
  const event = { id: 40, date: '2027-06-08', title: '9am Mass', type: 'service' }
  it('fulfilled row shows Said, not Release; a scheduled row still offers Release', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ intentions: [] })))
    wrap(<MassIntentionAssign event={event} assigned={[
      { id: 1, intention: 'Paul', status: 'fulfilled', calendar_event_id: 40 },
      { id: 2, intention: 'Robert', status: 'scheduled', calendar_event_id: 40 },
    ]} />)
    await screen.findByText('Paul')
    expect(screen.queryByRole('button', { name: `${en['sched.release']}: Paul` })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: `${en['sched.release']}: Robert` })).toBeInTheDocument()
    expect(screen.getByTestId('mi-said-badge')).toHaveTextContent(en['sched.saidBadge'])
  })
})

describe('SP-183 — the said date is shown', () => {
  it('list shows "Said <date>" for a fulfilled row, and says plainly when unknown', async () => {
    book()
    const row = (await screen.findAllByText('Fulfilled row'))[0].closest('tr')
    expect(within(row).getByTestId('mi-said-on').textContent).toMatch(/^Said .*2032/)
    const legacy = screen.getAllByText('Legacy fulfilled')[0].closest('tr')
    expect(within(legacy).getByTestId('mi-said-on')).toHaveTextContent(en['mi.saidDateUnknown'])
  })
})

describe('SP-184 — "+1" does not hide names from assistive technology', () => {
  it('every name is in the accessible text, the visible "+1" is aria-hidden', () => {
    wrap(<IntentionLine intentions={[{ intention: 'Paul Testcaller' }, { intention: '† Robert' }]} />)
    const line = screen.getByTestId('sched-intention-line')
    const sr = line.querySelector('.sr-only')
    expect(sr.textContent).toContain('Paul Testcaller')
    expect(sr.textContent).toContain('Robert')
    expect(line.querySelector('[aria-hidden="true"]').textContent).toMatch(/\+1$/)
  })
})

describe('SP-185 — calm after-Mass prompt on the Dashboard', () => {
  const today = parishTodayIso('America/Los_Angeles')
  const rows = [
    { id: 1, intention: 'A', status: 'scheduled', past_scheduled: true, mass_date: today },
    { id: 2, intention: 'B', status: 'scheduled', past_scheduled: true, mass_date: today },
    { id: 3, intention: 'C', status: 'scheduled', past_scheduled: true, mass_date: '2020-01-05' },
  ]
  it('admin sees a count of today\'s rows only, linking to the past-scheduled filter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ intentions: rows })))
    wrap(<AfterMassIntentionsPrompt />)
    const box = await screen.findByTestId('after-mass-prompt')
    expect(box).toHaveTextContent(en['dash.miPromptBody'].replace('{count}', '2'))
    expect(within(box).getByRole('link', { name: en['dash.miPromptAction'] })).toHaveAttribute('href', '/mass-intentions?view=past_scheduled')
  })
  it('nothing for a viewer (no request), nothing when none today, nothing on a failed read', async () => {
    auth.role = 'viewer'
    const f = vi.fn(async () => ok({ intentions: rows })); vi.stubGlobal('fetch', f)
    const v = wrap(<AfterMassIntentionsPrompt />)
    await new Promise(r => setTimeout(r, 20))
    expect(f).not.toHaveBeenCalled(); expect(screen.queryByTestId('after-mass-prompt')).toBeNull(); v.unmount()
    auth.role = 'staff'
    vi.stubGlobal('fetch', vi.fn(async () => ok({ intentions: [rows[2]] })))
    const s = wrap(<AfterMassIntentionsPrompt />)
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByTestId('after-mass-prompt')).toBeNull(); s.unmount()
    vi.stubGlobal('fetch', vi.fn(async () => ok({ error: 'x' }, 500)))
    wrap(<AfterMassIntentionsPrompt />)
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByTestId('after-mass-prompt')).toBeNull()
  })
  it('the book opens on the past-scheduled filter from the prompt link', async () => {
    book('/mass-intentions?view=past_scheduled')
    await waitFor(() => expect(calls.some(c => c.url.includes('view=past_scheduled'))).toBe(true))
  })
})

describe('#285 F6 — fulfilled offering and Mass are read-only', () => {
  it('edit form locks offering and Mass with the void note and shows the said date', async () => {
    book()
    const row = (await screen.findAllByText('Fulfilled row'))[0].closest('tr')
    fireEvent.click(within(row).getByRole('button', { name: en['mi.edit'] }))
    const offering = await screen.findByLabelText(en['mi.offering'])
    expect(offering).toHaveAttribute('readonly')
    expect(screen.getByLabelText(en['mi.assign'])).toBeDisabled()
    expect(screen.getByTestId('mi-offering-locked')).toHaveTextContent(en['mi.offeringLockedNote'])
    expect(screen.getByTestId('mi-edit-said-on').textContent).toMatch(/^Said .*2032/)
  })
})
