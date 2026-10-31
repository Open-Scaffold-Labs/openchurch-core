// V1.2 motion study #1: a record committed in this session settles onto
// the register like fresh ink the first time the register shows it, and
// only then. The words ("Entered in the register.") stay the primary
// acknowledgment; this is the supporting motion.

import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import SacramentalRegister from './SacramentalRegister'
import { markJustEntered } from '../utils/justEntered'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token',
    loading: false,
  }),
}))

const rec = (id, name) => ({
  id, type: 'baptism', member_name: name, date: '2026-09-13', place: 'St Test',
  minister: 'Fr. Test', certificate_no: `INK-${id}`, meta_attributes: {}, voided_at: null,
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/sacraments?')) return { ok: true, status: 200, json: async () => ({ records: [rec(41, 'Lucas Test'), rec(38, 'Amara Test')] }) }
    return { ok: true, status: 200, json: async () => ({ records: [], anniversaries: [] }) }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const renderRegister = () => render(
  <MemoryRouter><LocaleProvider><SacramentalRegister /></LocaleProvider></MemoryRouter>,
)

describe('register ink-settle (V1.2)', () => {
  it('CONTROL: with nothing committed this session, no row settles', async () => {
    renderRegister()
    const row = (await screen.findByText('Lucas Test')).closest('tr')
    expect(row.className).not.toMatch(/ink-settle/)
  })

  it('settles the just-committed row once, and leaves the others still', async () => {
    markJustEntered(41)
    renderRegister()
    const fresh = (await screen.findByText('Lucas Test')).closest('tr')
    const older = screen.getByText('Amara Test').closest('tr')
    expect(fresh.className).toMatch(/ink-settle/)
    expect(older.className).not.toMatch(/ink-settle/)

    cleanup()
    renderRegister()
    const again = (await screen.findByText('Lucas Test')).closest('tr')
    expect(again.className).not.toMatch(/ink-settle/)
  })
})
