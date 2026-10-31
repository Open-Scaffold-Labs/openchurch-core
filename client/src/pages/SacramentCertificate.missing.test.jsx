import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import SacramentCertificate from './SacramentCertificate'
import { LocaleProvider } from '../i18n'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

function wrap(path = '/register/999/certificate') {
  return render(
    <LocaleProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/register/:id/certificate" element={<SacramentCertificate />} />
        </Routes>
      </MemoryRouter>
    </LocaleProvider>,
  )
}

describe('SacramentCertificate missing state', () => {
  beforeEach(() => {
    localStorage.setItem('ochr_locale', 'en')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 404,
      ok: false,
      json: async () => ({}),
    })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('renders a designed not-found (serif line + way back), not a rose line', async () => {
    wrap()
    await waitFor(() => {
      expect(screen.getByTestId('cert-not-found')).toBeInTheDocument()
    })
    const box = screen.getByTestId('cert-not-found')
    expect(box).toHaveAttribute('role', 'alert')
    expect(screen.getByRole('heading', { level: 1 }).className).toMatch(/font-display/)
    expect(box.innerHTML).not.toMatch(/text-rose/)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/register')
    await waitFor(() => {
      expect(document.title.toLowerCase()).toMatch(/not found|no se encontr|could not be found/)
    })
  })
})
