// Saint 2026-10-22 afternoon day-of probe, main 6d7355c.
// SP-106: New Event accepted End 09:45 with Start 10:00, no warning.
// SP-107: Esc left the Event dialog open; Title input was named by its
//   placeholder (aria-label) instead of its visible label.
// SP-108: an empty Sunday (Nov 8) printed "No intention booked for this
//   week." AND "Nothing on the live schedule…" — two 'nothing' lines.
// SP-100: the empty weekly sheet Oct 24–30 pointed back to Oct 18 instead of
//   Nov 1, two days after the window.
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider, useConfirm } from '../components/ConfirmProvider'
import { EventModal, eventEndNotAfterStart } from './Schedule'
import SundayPacket from './SundayPacket'
import { nearestOutOfWindowDate } from './SacristySheet'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const { en } = STRINGS
const ok = (body) => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => ok({})))
})

function modal({ event = null, onClose = () => {}, onSave = () => {} } = {}) {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <EventModal event={event} onClose={onClose} onSave={onSave} onDelete={() => {}} members={[]} />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

describe('SP-106 end time before start', () => {
  it('rule: end must be strictly after start; half-typed times are not judged', () => {
    expect(eventEndNotAfterStart('10:00', '09:45')).toBe(true)
    expect(eventEndNotAfterStart('10:00', '10:00')).toBe(true)
    expect(eventEndNotAfterStart('10:00:00', '11:00')).toBe(false)
    expect(eventEndNotAfterStart('', '09:45')).toBe(false)
  })

  it('warns and blocks Add when End is before Start', () => {
    const onSave = vi.fn()
    modal({ onSave })
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Choir' } })
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2026-10-25' } })
    fireEvent.change(screen.getByLabelText(/^End/), { target: { value: '09:45' } })
    fireEvent.change(screen.getByLabelText(/^Start/), { target: { value: '10:00' } })
    expect(screen.getByTestId('event-end-before-start')).toHaveTextContent(en['sched.endBeforeStart'])
    expect(screen.getByLabelText(/^End/)).toHaveAttribute('aria-invalid', 'true')
    const add = screen.getByRole('button', { name: /Add Event/ })
    expect(add).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/^End/), { target: { value: '11:00' } })
    expect(screen.queryByTestId('event-end-before-start')).toBeNull()
    expect(add).not.toBeDisabled()
  })
})

describe('SP-107 Event dialog keyboard and labels', () => {
  it('Esc closes the dialog', () => {
    const onClose = vi.fn()
    modal({ onClose })
    expect(screen.getByRole('dialog', { name: 'New Event' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Title input is named by its visible label, not its placeholder', () => {
    modal()
    const title = screen.getByLabelText(/^Title/)
    expect(title.tagName).toBe('INPUT')
    expect(title).not.toHaveAttribute('aria-label')
  })
})

// R369-1 (TARS on #369): with a confirmation raised over the Event dialog,
// the Event dialog's trap must stand down for BOTH Tab and Escape. Before
// the fix its window-capture Tab handler pulled focus into the Event panel
// and ConfirmProvider pulled it back to Cancel, so Tab never reached Confirm.
function DeleteHarness({ onClose }) {
  const ask = useConfirm()
  return (
    <EventModal
      event={{ id: 7, title: 'Choir', date: '2026-10-25', start_time: '10:00', end_time: '11:00' }}
      onClose={onClose}
      onSave={() => {}}
      onDelete={() => { ask({ title: 'Delete this scheduled event?', confirmLabel: 'Delete event' }) }}
      members={[]}
    />
  )
}

function mountWithConfirm(onClose) {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <DeleteHarness onClose={onClose} />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

describe('R369-1 Event dialog yields keyboard to a confirmation above it', () => {
  it('Tab/Shift+Tab traverse the confirmation, Esc closes only it, focus returns', async () => {
    const onClose = vi.fn()
    mountWithConfirm(onClose)
    const del = screen.getAllByRole('button', { name: /Delete/ })[0]
    del.focus()
    fireEvent.click(del)
    const alert = await screen.findByRole('alertdialog')
    const btns = [...alert.querySelectorAll('button')]
    const first = btns[0]
    const last = btns[btns.length - 1]
    expect(document.activeElement).toBe(first)

    // Forward Tab from a non-last control is left to the browser: not
    // prevented, focus not yanked into the Event panel or back to Cancel.
    expect(fireEvent.keyDown(first, { key: 'Tab' })).toBe(true)
    expect(document.activeElement).toBe(first)
    // Backward Tab from a non-first control likewise.
    last.focus()
    expect(fireEvent.keyDown(last, { key: 'Tab', shiftKey: true })).toBe(true)
    expect(document.activeElement).toBe(last)
    // Wrap at both ends stays inside the confirmation.
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(first)
    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(last)
    expect(alert.contains(document.activeElement)).toBe(true)

    // Escape belongs to the top dialog only.
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // Focus is restored to the Delete control inside the Event dialog.
    expect(document.activeElement).toBe(del)
    // With the confirmation gone, the Event dialog owns keys again.
    const panel = screen.getByRole('dialog')
    expect(panel.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('standalone Event dialog still wraps Tab at both ends', () => {
    modal()
    const panel = screen.getByRole('dialog', { name: 'New Event' })
    const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const nodes = [...panel.querySelectorAll(sel)]
    const last = nodes[nodes.length - 1]
    last.focus()
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(nodes[0])
    expect(fireEvent.keyDown(nodes[0], { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(last)
  })
})

function mountPacket(body) {
  vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('/api/packet') ? ok(body) : ok({}))))
  return render(
    <MemoryRouter initialEntries={['/packet?date=2026-11-08']}>
      <LocaleProvider>
        <Routes><Route path="/packet" element={<SundayPacket />} /></Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

const EMPTY_SUNDAY = { parish: 'St Test', date: '2026-11-08', plan: null, serving: [], intentions: [], bulletin: null, lectionary: null, liturgical: null }

describe('SP-108 empty Sunday packet says nothing once', () => {
  it('prints only the one empty line', async () => {
    mountPacket(EMPTY_SUNDAY)
    expect(await screen.findByText(en['pkt.empty'])).toBeInTheDocument()
    expect(screen.queryByText(en['pkt.noIntentions'])).toBeNull()
  })

  it('a Sunday with a Mass still says no intention is booked', async () => {
    mountPacket({ ...EMPTY_SUNDAY, serving: [{ title: 'Sunday Mass', start_time: '10:00:00', assigned: [] }] })
    expect(await screen.findByText(en['pkt.noIntentions'])).toBeInTheDocument()
    expect(screen.queryByText(en['pkt.empty'])).toBeNull()
  })
})

describe('SP-100 sheet pointer measures from the nearer window edge', () => {
  it('Oct 24–30 points forward to Nov 1, not back to Oct 18', () => {
    const rows = [
      { id: 1, status: 'scheduled', mass_date: '2026-10-18' },
      { id: 2, status: 'scheduled', mass_date: '2026-11-01' },
    ]
    expect(nearestOutOfWindowDate(rows, '2026-10-24', '2026-10-30')).toBe('2026-11-01')
  })
})

// R369-2 (TARS on #369): distance is civil-day arithmetic, matching the
// server's PostgreSQL DATE differences, so a DST change inside the gap
// cannot flip the earlier-date tie rule. Run under TZ=America/Los_Angeles
// and TZ=UTC (see package script / report).
describe('R369-2 nearest pointer is civil-day, DST-proof', () => {
  it('Nov 7–13 window: Oct 31 and Nov 20 tie at 7 days, earlier date wins', () => {
    const rows = [
      { id: 1, status: 'scheduled', mass_date: '2026-11-20' },
      { id: 2, status: 'scheduled', mass_date: '2026-10-31' },
    ]
    expect(nearestOutOfWindowDate(rows, '2026-11-07', '2026-11-13')).toBe('2026-10-31')
  })
})
