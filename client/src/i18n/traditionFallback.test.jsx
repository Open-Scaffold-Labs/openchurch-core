// LOC-L1-01 — sparse tradition.es must not let trad.en shadow shared Spanish.
// Mutate any one of these and the matching test goes red:
//   1. t() falls back to trad.en before the locale dictionary
//   2. general + es sheet.title is no longer the shared Spanish liturgy title
//   3. episcopal.es sheet.title loses its intentional tradition override
//   4. general + en still uses the tradition English sheet title

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider, useLocale } from './index'
import { STRINGS } from './strings'
import { TRADITION_STRINGS } from './traditions'

let authUser = {
  id: 1,
  name: 'Secretary',
  role: 'admin',
  organization: { id: 1, name: 'Demo Church', locale: 'en', tradition: 'general' },
}

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authUser, token: 't', loading: false, canWrite: true, isAdmin: true }),
}))

function Probe({ k }) {
  const { t } = useLocale()
  return <p data-testid="copy">{t(k)}</p>
}

function mount({ locale = 'en', tradition = 'general', key = 'sheet.title' } = {}) {
  authUser = {
    ...authUser,
    organization: { ...authUser.organization, locale: 'en', tradition },
  }
  if (locale) localStorage.setItem('ochr_locale', locale)
  else localStorage.removeItem('ochr_locale')
  return render(
    <LocaleProvider>
      <Probe k={key} />
    </LocaleProvider>,
  )
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('LOC-L1-01 tradition locale precedence', () => {
  it('general + es uses the shared Spanish liturgy sheet title, not trad.en', () => {
    expect(TRADITION_STRINGS.general.es['sheet.title']).toBeUndefined()
    expect(TRADITION_STRINGS.general.en['sheet.title']).toBe('Intentions for the Week')
    expect(STRINGS.es['sheet.title']).toBe('Intenciones de Misa para la Semana')
    mount({ locale: 'es', tradition: 'general', key: 'sheet.title' })
    expect(screen.getByTestId('copy').textContent).toBe('Intenciones de Misa para la Semana')
    expect(screen.getByTestId('copy').textContent).not.toBe('Intentions for the Week')
  })

  it('episcopal + es keeps the intentional tradition Spanish override', () => {
    expect(TRADITION_STRINGS.episcopal.es['sheet.title']).toBe('Intenciones de la Semana')
    mount({ locale: 'es', tradition: 'episcopal', key: 'sheet.title' })
    expect(screen.getByTestId('copy').textContent).toBe('Intenciones de la Semana')
    expect(screen.getByTestId('copy').textContent).not.toBe(STRINGS.es['sheet.title'])
  })

  it('general + en still uses the tradition English sheet title', () => {
    mount({ locale: 'en', tradition: 'general', key: 'sheet.title' })
    expect(screen.getByTestId('copy').textContent).toBe('Intentions for the Week')
    expect(screen.getByTestId('copy').textContent).not.toBe(STRINGS.en['sheet.title'])
  })

  it('a missing-key still falls through instead of blanking the screen', () => {
    mount({ locale: 'es', tradition: 'general', key: 'does.not.exist' })
    expect(screen.getByTestId('copy').textContent).toBe('does.not.exist')
  })
})
