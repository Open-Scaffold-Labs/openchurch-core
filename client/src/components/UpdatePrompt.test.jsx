// Refresh reloads the page. Unsaved page state is discarded.
//
// Clicking Refresh calls updateServiceWorker(true), which posts
// SKIP_WAITING. The new worker takes control and the plugin reloads
// (`window.location.reload()`). Claiming "your in-progress work isn't
// affected" is a lie. Reintroducing that claim — in chrome or in the
// i18n strings — goes red. (OC-READY-01-025)

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { pwaRegisterHarness } from '../test/pwa-register-react'
import UpdatePrompt from './UpdatePrompt'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const FALSE_CLAIM = /in-progress work isn['’']t affected|el trabajo en (curso|progreso).{0,60}no se ve afectado/i

function view() {
  return render(
    <LocaleProvider>
      <UpdatePrompt />
    </LocaleProvider>,
  )
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  pwaRegisterHarness.needRefresh = true
  pwaRegisterHarness.updateServiceWorker = vi.fn()
})

describe('UpdatePrompt chrome is reload-honest (OC-READY-01-025)', () => {
  it('THE BANNER NAMES THE RELOAD AND DOES NOT CLAIM WORK IS UNAFFECTED', () => {
    view()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/update available/i)
    expect(dialog.textContent).toMatch(/reload/i)
    expect(dialog.textContent).toMatch(/unsaved/i)
    expect(dialog.textContent).not.toMatch(FALSE_CLAIM)
  })

  it('SPANISH CHROME STAYS RELOAD-HONEST — NO UNAFFECTED CLAIM', () => {
    localStorage.setItem('ochr_locale', 'es')
    view()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/actualizaci[oó]n disponible/i)
    expect(dialog.textContent).toMatch(/recarga/i)
    expect(dialog.textContent).toMatch(/no guardado/i)
    expect(dialog.textContent).not.toMatch(FALSE_CLAIM)
  })

  it('i18n strings and the component wiring cannot reintroduce the claim', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'UpdatePrompt.jsx'), 'utf8')
    expect(src).toMatch(/t\('update\.body'\)/)
    expect(src).toMatch(/updateServiceWorker\(true\)/)
    expect(src).not.toMatch(/your in-progress work isn't affected/)
    expect(STRINGS.en['update.body']).toMatch(/reload/i)
    expect(STRINGS.en['update.body']).toMatch(/unsaved/i)
    expect(STRINGS.en['update.body']).not.toMatch(FALSE_CLAIM)
    expect(STRINGS.es['update.body']).toMatch(/recarga/i)
    expect(STRINGS.es['update.body']).toMatch(/no guardado/i)
    expect(STRINGS.es['update.body']).not.toMatch(FALSE_CLAIM)
  })

  it('Refresh still asks the plugin to skip waiting — policy is unchanged', () => {
    view()
    screen.getByRole('button', { name: /refresh/i }).click()
    expect(pwaRegisterHarness.updateServiceWorker).toHaveBeenCalledWith(true)
  })
})
