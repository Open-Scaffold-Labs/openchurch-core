import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import NotFound from './NotFound'
import { LocaleProvider } from '../i18n'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

describe('NotFound Quiet Craft 5', () => {
  it('uses a serif title, one sentence, and a way home — not a bare red line', () => {
    localStorage.setItem('ochr_locale', 'en')
    render(
      <LocaleProvider>
        <MemoryRouter>
          <NotFound home="/" />
        </MemoryRouter>
      </LocaleProvider>,
    )
    const title = screen.getByRole('heading', { level: 1 })
    expect(title.className).toMatch(/font-display/)
    expect(title).toHaveTextContent('Page not found')
    expect(document.body.innerHTML).not.toMatch(/text-rose/)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/')
    expect(screen.getByRole('status')).toBeTruthy()
    expect(document.title).toBe('Page not found')
  })

  it('sets a Spanish document title', () => {
    localStorage.setItem('ochr_locale', 'es')
    render(
      <LocaleProvider>
        <MemoryRouter>
          <NotFound home="/" />
        </MemoryRouter>
      </LocaleProvider>,
    )
    expect(document.title).toBe('Página no encontrada')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Página no encontrada')
  })
})
