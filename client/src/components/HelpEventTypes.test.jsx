// MIN-48 (Saint, 20 Oct): the New Event dialog offers Service / Meeting /
// Event with no explanation. Help now explains them, consistent with which
// calendar types can take a Mass intention (utils/massEvent.js).
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import HelpPanel from './HelpPanel'
import { MODULE_HELP } from '../data/helpContent'
import { isMassCalendarEvent, isPrimaryMassCalendarEvent } from '../utils/massEvent'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

beforeEach(() => { localStorage.removeItem('ochr_locale') })

const section = () => (MODULE_HELP.schedule.sections || []).find(s => /Service, Meeting, Event/.test(s.title))

describe('MIN-48 Help explains Service / Meeting / Event', () => {
  it('names each type and matches which types can take an intention', () => {
    const s = section()
    expect(s).toBeTruthy()
    const byLabel = Object.fromEntries(s.items.map(i => [i.label, i.desc]))
    expect(Object.keys(byLabel)).toEqual(['Service', 'Meeting', 'Event'])
    expect(isPrimaryMassCalendarEvent({ type: 'service' })).toBe(true)
    expect(byLabel.Service).toMatch(/listed first/)
    expect(isMassCalendarEvent({ type: 'meeting' })).toBe(false)
    expect(byLabel.Meeting).toMatch(/cannot take a Mass intention/)
    expect(isMassCalendarEvent({ type: 'event' })).toBe(true)
    expect(byLabel.Event).toMatch(/can still take a Mass intention/)
  })
  it('Help search for "meeting" finds it', () => {
    render(<LocaleProvider><HelpPanel open onClose={() => {}} /></LocaleProvider>)
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['help.searchPh']), { target: { value: 'meeting' } })
    expect(screen.getByText('Schedule — Event types: Service, Meeting, Event')).toBeInTheDocument()
  })
})
