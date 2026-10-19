// SP-066: the weekly sheet's "fulfilled" word must clear WCAG AA (4.5:1)
// on the white sheet, on screen and in print. The defect was inheriting
// the stipend column's ink-500. Restoring that (no own color, or ink-500
// again) goes red. Meaning and placement stay: same word, right-hand column.
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import tailwindConfig from '../../tailwind.config.js'
import SacristySheet from './SacristySheet'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', timezone: 'UTC' } },
    token: 't', loading: false,
  }),
}))

const WHITE = '#FFFFFF'
const ink = tailwindConfig.theme.extend.colors.ink

function lin(c) {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
function lum(hex) {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function contrast(fg, bg) {
  const L1 = lum(fg)
  const L2 = lum(bg)
  const hi = Math.max(L1, L2)
  const lo = Math.min(L1, L2)
  return (hi + 0.05) / (lo + 0.05)
}

function colorUtility(className, prefix) {
  const hit = className.split(/\s+/).find(c => c.startsWith(prefix) && !c.slice(prefix.length).includes('/'))
  if (!hit) return null
  const name = hit.slice(prefix.length)
  const [family, step] = name.split('-')
  const scale = tailwindConfig.theme.extend.colors[family]
  if (!scale || !scale[step]) return null
  return { utility: hit, hex: scale[step] }
}

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function renderSheet() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
    if (u.includes('/api/mass-intentions/weekly')) {
      return ok({
        intentions: [
          {
            id: 15,
            mass_date: '2026-09-16',
            mass_title: 'Sunday Mass',
            mass_time: '09:00',
            status: 'fulfilled',
            formatted_intention: 'FOR THE PARISH',
            requested_by: 'Sample requester',
            stipend: 10,
          },
          {
            id: 16,
            mass_date: '2026-09-16',
            status: 'scheduled',
            formatted_intention: 'STILL SCHEDULED',
            requested_by: 'Sample requester',
            fulfilment_label: 'previously recorded fulfilment',
          },
        ],
        generated_at: '2026-09-16T15:00:00.000Z',
        timezone: 'UTC',
      })
    }
    return ok({})
  }))
  return render(
    <MemoryRouter initialEntries={['/mass-intentions/print?start=2026-09-15']}>
      <LocaleProvider>
        <Routes>
          <Route path="/mass-intentions/print" element={<SacristySheet />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale') })
afterEach(() => vi.unstubAllGlobals())

describe('SP-066 fulfilled tag contrast', () => {
  it('screen and print colors clear 4.5:1 on white and are darker than the inherited ink-500', async () => {
    renderSheet()
    const tag = await screen.findByTestId('sheet-fulfilled')
    expect(tag).toHaveTextContent(STRINGS.en['sheet.fulfilled'])
    expect(tag.className).toMatch(/\bitalic\b/)

    const column = tag.parentElement
    expect(column.className).toMatch(/\btext-right\b/)
    expect(column.className).toMatch(/\btext-ink-500\b/)

    let paper = tag.parentElement
    while (paper && !/\bbg-white\b/.test(paper.className || '')) paper = paper.parentElement
    expect(paper).toBeTruthy()
    expect(paper.className).not.toMatch(/print:bg-(?!white\b)/)

    const before = contrast(ink[500], WHITE)
    const screenColor = colorUtility(tag.className, 'text-')
    const printColor = colorUtility(tag.className, 'print:text-')
    expect(screenColor, 'fulfilled tag needs its own screen color').toBeTruthy()
    expect(printColor, 'fulfilled tag needs its own print color').toBeTruthy()
    expect(screenColor.utility).not.toMatch(/ink-500|ink-400/)
    expect(printColor.utility).not.toMatch(/ink-500|ink-400/)

    const screenRatio = contrast(screenColor.hex, WHITE)
    const printRatio = contrast(printColor.hex, WHITE)
    expect(screenRatio).toBeGreaterThanOrEqual(4.5)
    expect(printRatio).toBeGreaterThanOrEqual(4.5)
    expect(screenRatio).toBeGreaterThan(before)
    expect(printRatio).toBeGreaterThan(before)

    const prior = screen.getByText('previously recorded fulfilment')
    expect(prior).not.toHaveAttribute('data-testid', 'sheet-fulfilled')
    expect(prior.className).not.toMatch(/text-ink-800|print:text-ink-900/)
    expect(screen.getAllByTestId('sheet-fulfilled')).toHaveLength(1)
  })
})
