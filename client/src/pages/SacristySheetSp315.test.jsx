// SP-315: weekly sheet day headings name All Souls on Nov 2 (and show the note).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import SacristySheet from './SacristySheet'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1, name: 'Secretary', role: 'admin',
      organization: { id: 1, name: 'St Test', locale: 'en', timezone: 'America/Los_Angeles' },
    },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

describe('SP-315 sheet All Souls day label + note', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/liturgical/range')) {
        return ok({
          '2026-11-01': { feast_name: 'All Saints', color: 'White', season: 'Ordinary Time' },
          '2026-11-02': { feast_name: 'All Souls', color: 'Purple', season: 'Ordinary Time' },
        })
      }
      if (u.includes('/api/liturgical')) {
        return ok({ feast_name: 'All Saints', color: 'White', season: 'Ordinary Time' })
      }
      if (u.includes('/api/mass-intentions/weekly')) {
        return ok({
          intentions: [{
            id: 10909,
            mass_date: '2026-11-02',
            mass_title: '[Sample] Sunday Mass',
            mass_time: '10:00',
            formatted_intention: '† Saint test - for the repose of the souls of the Testenvelope family (All Souls)',
            note: 'Joseph, Mary, Anne, and Peter Testenvelope',
            requested_by: 'Teresa Testenvelope',
            status: 'scheduled',
            stipend: '5.00',
          }],
          generated_at: '2026-10-30T19:00:00Z',
          timezone: 'America/Los_Angeles',
          intention_total: 1,
        })
      }
      return ok({})
    }))
  })

  it('labels Monday Nov 2 as All Souls and prints the note names', async () => {
    render(
      <MemoryRouter initialEntries={['/mass-intentions/print?start=2026-10-31']}>
        <LocaleProvider>
          <Routes>
            <Route path="/mass-intentions/print" element={<SacristySheet />} />
          </Routes>
        </LocaleProvider>
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('sheet-day-feast').textContent).toMatch(/All Souls/)
    })
    expect(screen.getByTestId('sheet-intention-note').textContent)
      .toMatch(/Joseph, Mary, Anne, and Peter Testenvelope/)
    // Mass line also carries the feast when the title does not.
    expect(screen.getByText(/Sample.*Sunday Mass.*All Souls/i)).toBeInTheDocument()
  })
})
