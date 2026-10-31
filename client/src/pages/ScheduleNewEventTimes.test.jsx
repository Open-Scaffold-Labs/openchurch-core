// SP-101 (Saint 2026-10-22): the New Event end time was blank after the
// start time was picked, and the time inputs had no programmatic label.
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { EventModal, defaultEndTime } from './Schedule'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
})

function modal(event = null) {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <EventModal event={event} onClose={() => {}} onSave={() => {}} onDelete={() => {}} members={[]} />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

describe('defaultEndTime', () => {
  it('adds one hour and never wraps past midnight', () => {
    expect(defaultEndTime('10:00')).toBe('11:00')
    expect(defaultEndTime('09:45')).toBe('10:45')
    expect(defaultEndTime('23:30')).toBe('23:59')
    expect(defaultEndTime('')).toBe('')
    expect(defaultEndTime('nope')).toBe('')
  })
})

describe('New Event times (SP-101)', () => {
  it('time inputs are reachable by their visible labels', () => {
    modal()
    expect(screen.getByLabelText(/^Start/).getAttribute('type')).toBe('time')
    expect(screen.getByLabelText(/^End/).getAttribute('type')).toBe('time')
  })

  it('picking a start time fills the end time one hour later', () => {
    modal()
    fireEvent.change(screen.getByLabelText(/^Start/), { target: { value: '10:00' } })
    expect(screen.getByLabelText(/^End/).value).toBe('11:00')
    fireEvent.change(screen.getByLabelText(/^Start/), { target: { value: '08:30' } })
    expect(screen.getByLabelText(/^End/).value).toBe('09:30')
  })

  it('a typed end time is never overwritten by a later start change', () => {
    modal()
    fireEvent.change(screen.getByLabelText(/^Start/), { target: { value: '10:00' } })
    fireEvent.change(screen.getByLabelText(/^End/), { target: { value: '12:15' } })
    fireEvent.change(screen.getByLabelText(/^Start/), { target: { value: '10:30' } })
    expect(screen.getByLabelText(/^End/).value).toBe('12:15')
  })

  it('editing an existing event keeps its saved end time', () => {
    modal({ id: 7, title: 'Mass', date: '2026-11-01', start_time: '10:00', end_time: '11:30', type: 'service', assigned_to: [] })
    fireEvent.change(screen.getByLabelText(/^Start/), { target: { value: '09:00' } })
    expect(screen.getByLabelText(/^End/).value).toBe('11:30')
  })
})
