// SP-253: Help explains weekday Mass intentions and is searchable.
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import HelpPanel from './HelpPanel'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const { en, es } = STRINGS
const TITLE = 'help.miWeekdayMassTitle'
const BODY = 'help.miWeekdayMassBody'

function mount() {
  return render(
    <LocaleProvider>
      <HelpPanel open onClose={() => {}} />
    </LocaleProvider>,
  )
}

beforeEach(() => { localStorage.removeItem('ochr_locale') })

describe('SP-253 weekday Mass Help', () => {
  it('EN and ES entries exist and carry the searchable tokens', () => {
    expect(en[TITLE]).toContain('weekday Mass')
    expect(en[BODY]).toContain('weekday Mass')
    expect(es[TITLE]).toContain('Misa de entre semana')
    expect(es[BODY]).toContain('Misa de entre semana')
    expect(es[TITLE]).not.toBe(en[TITLE])
  })

  it('FAQ browse and search find the EN entry', () => {
    const first = mount()
    fireEvent.click(screen.getByRole('button', { name: en['help.tabFaq'] }))
    fireEvent.click(screen.getByRole('button', { name: en[TITLE] }))
    expect(screen.getByText(en[BODY])).toBeInTheDocument()
    first.unmount()
    const second = mount()
    fireEvent.change(screen.getByPlaceholderText(en['help.searchPh']), { target: { value: 'weekday Mass' } })
    expect(screen.getByText(en[TITLE])).toBeInTheDocument()
    second.unmount()
  })

  it('Spanish search for Misa de entre semana finds the ES entry', () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    fireEvent.change(screen.getByPlaceholderText(es['help.searchPh']), { target: { value: 'Misa de entre semana' } })
    expect(screen.getByText(es[TITLE])).toBeInTheDocument()
  })
})
