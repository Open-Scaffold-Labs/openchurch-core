// Toast region / dismiss aria-labels go through strings.js + t().
// Hard-coded English ("Notifications" / "Dismiss") is the remaining
// toast chrome after ErrorBoundary #105. Restoring those literals
// in the component goes red. (OC-READY-01-028)
//
// ToastProvider sits inside LocaleProvider in main.jsx — same rule as
// ConfirmProvider: a provider cannot read a context mounted below it.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider, useToast } from './ToastProvider'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const SRC_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ToastProvider.jsx')
const HARD_EN = ['Notifications', 'Dismiss']

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function Fire({ message = 'Saved' }) {
  const toast = useToast()
  return (
    <button type="button" onClick={() => toast.info(message, { duration: 0 })}>
      notify
    </button>
  )
}

function view() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <Fire />
      </ToastProvider>
    </LocaleProvider>,
  )
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('ToastProvider aria is translated (OC-READY-01-028)', () => {
  it('ENGLISH REGION AND DISMISS USE t() COPY', async () => {
    view()
    expect(screen.getByRole('region', { name: STRINGS.en['toast.region'] })).toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: 'notify' }).click()
    })
    expect(screen.getByRole('button', { name: STRINGS.en['toast.dismiss'] })).toBeInTheDocument()
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('SPANISH REGION AND DISMISS ARE SPANISH — NOT THE ENGLISH ARIA', async () => {
    localStorage.setItem('ochr_locale', 'es')
    view()
    expect(screen.getByRole('region', { name: STRINGS.es['toast.region'] })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: STRINGS.en['toast.region'] })).toBeNull()
    await act(async () => {
      screen.getByRole('button', { name: 'notify' }).click()
    })
    expect(screen.getByRole('button', { name: STRINGS.es['toast.dismiss'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['toast.dismiss'] })).toBeNull()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN aria', () => {
    const src = readFileSync(SRC_PATH, 'utf8')
    const jsx = stripComments(src)
    expect(src).toMatch(/t\('toast\.region'\)/)
    expect(src).toMatch(/t\('toast\.dismiss'\)/)
    expect(src).toMatch(/useLocale\(/)
    expect(jsx).not.toMatch(/aria-label=["']Notifications["']/)
    expect(jsx).not.toMatch(/aria-label=["']Dismiss["']/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code aria ${JSON.stringify(phrase)}`).not.toMatch(
        new RegExp(`aria-label=["']${phrase}["']`),
      )
    }
    expect(STRINGS.en['toast.region']).toBe('Notifications')
    expect(STRINGS.en['toast.dismiss']).toBe('Dismiss')
    expect(STRINGS.es['toast.region']).toMatch(/notificaciones/i)
    expect(STRINGS.es['toast.dismiss']).toMatch(/cerrar/i)
    expect(STRINGS.es['toast.region']).not.toBe(STRINGS.en['toast.region'])
    expect(STRINGS.es['toast.dismiss']).not.toBe(STRINGS.en['toast.dismiss'])
  })

  it('ToastProvider throws outside LocaleProvider — ConfirmProvider pattern', () => {
    expect(() => render(<ToastProvider><span>child</span></ToastProvider>))
      .toThrow(/useLocale must be used inside <LocaleProvider>/)
  })
})
