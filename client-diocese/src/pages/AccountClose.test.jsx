// Permanent closure on the chancery account page, beside turning the
// login off. English and Spanish confirmation. Success signs out.
// A last-admin refusal stays and does not show the server sentence.

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { STRINGS } from '../i18n/strings'
import { CloseLoginCard } from './Account'

const logout = vi.hoisted(() => vi.fn())

vi.mock('../authContext', () => ({
  useAuth: () => ({ logout: (...args) => logout(...args) }),
}))

function mount() {
  return render(
    <ConfirmProvider>
      <CloseLoginCard />
    </ConfirmProvider>
  )
}

beforeEach(() => {
  logout.mockClear()
  localStorage.removeItem('ochr_locale')
  vi.unstubAllGlobals()
})

describe('closing a chancery login', () => {
  it('English and Spanish confirmation stay distinct from turning the login off', () => {
    expect(STRINGS.en['account.close.confirmBody']).toMatch(/cannot be turned back on/i)
    expect(STRINGS.en['account.close.confirmBody']).toMatch(/chancery/i)
    expect(STRINGS.en['account.close.confirmBody']).toMatch(/every copy is gone/i)
    expect(STRINGS.es['account.close.confirmBody']).toMatch(/cancillería/i)
    expect(STRINGS.es['account.close.title']).not.toBe(STRINGS.en['account.close.title'])
    expect(STRINGS.en['account.close.title']).not.toBe(STRINGS.en['account.deactivate.title'])
  })

  it('shows the Spanish confirm', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['account.close.submit'] }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAccessibleName(STRINGS.es['account.close.confirmTitle'])
    expect(dialog).toHaveTextContent(STRINGS.es['account.close.confirmBody'])
  })

  it('signs out only when the login is closed, and a refusal stays', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 409,
      json: async () => ({ error: 'Cannot close the only active admin.' }),
    })))
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['account.close.submit'] }))
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['account.close.confirm'] }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(STRINGS.en['account.close.lastAdmin'])
    expect(logout).not.toHaveBeenCalled()
    cleanup()

    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      json: async () => ({ closed: true }),
    })))
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['account.close.submit'] }))
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['account.close.confirm'] }))
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
  })
})
