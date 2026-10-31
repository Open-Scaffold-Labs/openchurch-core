// SP-158: the † shows only for an intention for the departed (the book,
// sheet and packet rule). SP-159: Release asks before it POSTs unassign.
// SP-160 (client half): the review refuses a future day or future Mass.
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from './ToastProvider'
import MassIntentionAssign from './MassIntentionAssign'
import { splitDeathMark, intentionForDeparted } from '../utils/deathMark'
import { saidRowFuture, parishTodayIso, MARK_SAID_EXCLUSION_CODES } from '../utils/markSaid'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const { en } = STRINGS
const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const event = { id: 40, date: '2027-06-08', title: '9am Mass', type: 'service' }
const wrap = (node) => render(<MemoryRouter><LocaleProvider><ToastProvider>{node}</ToastProvider></LocaleProvider></MemoryRouter>)
const DEPARTED = { id: 3, intention: '+ Ana Ruiz', formatted_intention: '† Ana Ruiz', requested_by: 'Family', calendar_event_id: 40, status: 'scheduled' }
const LIVING = { id: 4, intention: 'Thanksgiving for the Lopez family', formatted_intention: 'Thanksgiving for the Lopez family', requested_by: 'Lopez', calendar_event_id: 40, status: 'scheduled' }
const AWAIT_LIVING = { id: 8, intention: 'Health of Maria', requested_by: 'Maria', calendar_event_id: null, status: 'open' }

let calls
beforeEach(() => {
  vi.unstubAllGlobals()
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET' })
    if (String(url).includes('/awaiting')) return ok({ intentions: [AWAIT_LIVING] })
    if (String(url).includes('/unassign')) return ok({ ...LIVING, calendar_event_id: null, status: 'open' })
    return ok({})
  }))
})

describe('SP-158 dagger only for the departed', () => {
  it('helper matches the book rule', () => {
    expect(intentionForDeparted('† Ana')).toBe(true)
    expect(intentionForDeparted(' + Ana')).toBe(true)
    expect(intentionForDeparted('Thanksgiving')).toBe(false)
    expect(splitDeathMark('+ Ana')).toEqual({ departed: true, text: 'Ana' })
    expect(splitDeathMark('Health of Maria')).toEqual({ departed: false, text: 'Health of Maria' })
  })

  it('Edit Event panel: † on the departed row only, none on living or awaiting rows', async () => {
    wrap(<MassIntentionAssign event={event} assigned={[DEPARTED, LIVING]} />)
    await screen.findByText(/Health of Maria/)
    const items = screen.getAllByRole('listitem')
    const text = items.map(li => li.textContent)
    expect(text.find(x => x.includes('Ana Ruiz'))).toMatch(/^† Ana Ruiz/)
    expect(text.find(x => x.includes('Lopez family'))).not.toContain('†')
    expect(text.find(x => x.includes('Health of Maria'))).not.toContain('†')
  })

  it('Schedule tile and 390px card no longer hard-code the dagger', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'Schedule.jsx'), 'utf8')
    expect(src).not.toMatch(/<span className="font-display">†<\/span> \{first\}/)
    expect(src).toMatch(/splitDeathMark/)
  })
})

describe('SP-159 Release asks first', () => {
  it('first click sends nothing; Keep cancels; Yes releases', async () => {
    wrap(<MassIntentionAssign event={event} assigned={[LIVING]} />)
    const b = await screen.findByRole('button', { name: /release: thanksgiving/i })
    await act(async () => { fireEvent.click(b) })
    expect(calls.some(c => c.url.includes('/unassign'))).toBe(false)
    expect(screen.getByText(en['sched.releaseConfirmBody'])).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['sched.releaseKeep'] })) })
    expect(calls.some(c => c.url.includes('/unassign'))).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /release: thanksgiving/i })) })
    await act(async () => { fireEvent.click(screen.getByTestId('mi-release-confirm')) })
    expect(calls.filter(c => c.url.includes('/unassign') && c.method === 'POST')).toHaveLength(1)
  })
})

describe('SP-160 review refuses a future Mass', () => {
  it('future typed day or future linked Mass is not ready; past is', () => {
    const today = '2026-10-24'
    expect(saidRowFuture({ date: '2026-10-25', massDay: '' }, today)).toBe(true)
    expect(saidRowFuture({ date: '2026-10-20', massDay: '2026-11-01' }, today)).toBe(true)
    expect(saidRowFuture({ date: '2026-10-24', massDay: '2026-10-24' }, today)).toBe(false)
    expect(saidRowFuture({ date: '2026-10-01', massDay: '' }, null)).toBe(true)
    expect(parishTodayIso('America/Los_Angeles', new Date('2026-10-25T03:00:00Z'))).toBe('2026-10-24')
    expect(MARK_SAID_EXCLUSION_CODES.has('future_mass')).toBe(true)
  })
})
