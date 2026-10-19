// SP-065: Help explains how to mark an intention fulfilled, in the language
// the secretary is using. The words describe the book and the weekly sheet
// as they are — status, save, confirmation after accept, refusal when no
// Mass is assigned, the sheet's "fulfilled" word, offering unchanged.
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
const TITLE = 'help.miFulfillHowTitle'
const BODY = 'help.miFulfillHowBody'

function mount() {
  return render(
    <LocaleProvider>
      <HelpPanel open onClose={() => {}} />
    </LocaleProvider>,
  )
}

beforeEach(() => { localStorage.removeItem('ochr_locale') })

describe('SP-065 how to mark an intention fulfilled', () => {
  it('EN and ES entries exist, differ, and name the real controls', () => {
    expect(en[TITLE]).toBeTruthy()
    expect(es[TITLE]).toBeTruthy()
    expect(en[BODY]).toBeTruthy()
    expect(es[BODY]).toBeTruthy()
    expect(es[TITLE]).not.toBe(en[TITLE])
    expect(es[BODY]).not.toBe(en[BODY])
    expect(en[BODY]).toContain(en['mi.edit'])
    expect(en[BODY]).toContain(en['mi.status'])
    expect(en[BODY]).toContain(en['mi.fulfilled'])
    expect(en[BODY]).toContain(en['mi.saveChanges'])
    expect(en[BODY]).toContain(`"${en['sheet.fulfilled']}"`)
    expect(es[BODY]).toContain(es['mi.edit'])
    expect(es[BODY]).toContain(es['mi.status'])
    expect(es[BODY]).toContain(es['mi.fulfilled'])
    expect(es[BODY]).toContain(es['mi.saveChanges'])
    expect(es[BODY]).toContain(`"${es['sheet.fulfilled']}"`)
    for (const text of [en[TITLE], en[BODY], es[TITLE], es[BODY]]) {
      expect(text).not.toMatch(/missed|discharged|obligation|celebrated|canonical|stipend|elsewhere/i)
      expect(text).not.toMatch(/omitid|perdid|obligaci|can[oó]nic|estipendio|celebrad/i)
    }
  })

  it('the guide and the FAQ show the English how-to', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Intentions' }))
    const guide = screen.getByTestId('help-fulfill-howto')
    expect(guide).toHaveTextContent(en[TITLE])
    expect(guide).toHaveTextContent(en[BODY])
    fireEvent.click(screen.getByRole('button', { name: en['help.tabFaq'] }))
    fireEvent.click(screen.getByRole('button', { name: en[TITLE] }))
    expect(screen.getByText(en[BODY])).toBeInTheDocument()
  })

  it('a Spanish session shows the Spanish how-to and not the English one', () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Intentions' }))
    const guide = screen.getByTestId('help-fulfill-howto')
    expect(guide).toHaveTextContent(es[TITLE])
    expect(guide).toHaveTextContent(es[BODY])
    expect(guide).not.toHaveTextContent(en[BODY])
    fireEvent.click(screen.getByRole('button', { name: es['help.tabFaq'] }))
    fireEvent.click(screen.getByRole('button', { name: es[TITLE] }))
    expect(screen.getByText(es[BODY])).toBeInTheDocument()
    expect(screen.queryByText(en[BODY])).not.toBeInTheDocument()
  })

  it('search finds the how-to in the active language', () => {
    mount()
    fireEvent.change(screen.getByPlaceholderText(en['help.searchPh']), { target: { value: 'does not change the offering' } })
    expect(screen.getByText(en[TITLE])).toBeInTheDocument()
  })
})
