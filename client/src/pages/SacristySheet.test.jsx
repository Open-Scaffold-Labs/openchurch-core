// Sacristy week-window honesty (OC-READY-01-004 / OC-READY-01-007 / OC-READY-01-008).
// The book lists every intention; the sheet keeps a 7-day window.
// Mutate any one of these and the matching test goes red:
//   1. Empty copy still says "this week" as if the parish book is empty
//   2. An empty week dumps the whole book onto the sheet
//   3. Out-of-window dated rows no longer disclose or offer a jump
//   4. Empty week peeks the first book page (limit=50) instead of nearest-outside
//   5. A missing start defaults to today+6 or a Sunday-started week instead of the vigil week
//   6. Undated-only empty week stays silent (no book-waiting disclosure)
//   7. Undated waiting is dumped onto the printed week

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import ErrorBoundary from '../components/ErrorBoundary'
import SacristySheet, {
  fmtSheetStipend,
  fmtTime,
  generationClock,
  groupSheetIntentions,
  listingDate,
  nearestOutOfWindowDate,
  resolvedSheetTimeZone,
  sundayStartOf,
} from './SacristySheet'

const SHEET_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SacristySheet.jsx'), 'utf8')
const SHEET_WEEK_KEYS = ['sheet.prevWeek', 'sheet.nextWeek']
const SHEET_LOAD_KEY = 'sheet.loadFailed'
const HARD_EN_WEEK_ARIA = ['Previous week', 'Next week']
const HARD_EN_LOAD = "Couldn't load this week's intentions. Nothing was lost — please retry."

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const sheetAuth = vi.hoisted(() => ({ timezone: 'UTC' }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1, name: 'Secretary', role: 'admin',
      organization: { id: 1, name: 'St Test', locale: 'en', timezone: sheetAuth.timezone },
    },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

const OUTSIDE = {
  id: 13,
  mass_date: '2026-09-13',
  status: 'scheduled',
  formatted_intention: 'OUT-OF-WINDOW SAMPLE',
  requested_by: 'Sample requester',
}

const INSIDE = {
  id: 15,
  mass_date: '2026-09-16',
  status: 'scheduled',
  formatted_intention: 'IN-WINDOW SAMPLE',
  requested_by: 'Sample requester',
}

function queryStart(url) {
  const u = String(url)
  const q = u.includes('?') ? u.slice(u.indexOf('?')) : ''
  return new URLSearchParams(q).get('start')
}

function stubFetch({ weekly, weeklyStatus = 200, outside = null, undatedWaiting = false, generatedAt = null, timezone = null, intentionTotal = null, truncated = null } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
    if (u.includes('/api/mass-intentions/nearest-outside')) {
      const date = typeof outside === 'function' ? outside(queryStart(u)) : outside
      const waiting = typeof undatedWaiting === 'function' ? undatedWaiting(queryStart(u)) : undatedWaiting
      const count = waiting ? 2 : 0
      return ok({ date, undated_waiting: Boolean(waiting), undated_waiting_count: count })
    }
    if (u.includes('/api/mass-intentions/weekly')) {
      if (weeklyStatus !== 200) {
        return { ok: false, status: weeklyStatus, json: async () => ({ error: 'fail' }) }
      }
      const rows = typeof weekly === 'function' ? weekly(queryStart(u)) : (weekly ?? [])
      const body = { intentions: rows }
      if (generatedAt) body.generated_at = generatedAt
      if (timezone) body.timezone = timezone
      if (intentionTotal != null) body.intention_total = intentionTotal
      if (truncated != null) body.truncated = truncated
      return ok(body)
    }
    if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
    return ok({})
  }))
}

function renderSheet(path = '/mass-intentions/print?start=2026-09-15') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <Routes>
          <Route path="/mass-intentions/print" element={<SacristySheet />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function renderGuarded(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <ErrorBoundary>
          <Routes>
            <Route path="/mass-intentions/print" element={<SacristySheet />} />
          </Routes>
        </ErrorBoundary>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  sheetAuth.timezone = 'UTC'
})

describe('nearestOutOfWindowDate', () => {
  it('returns the closest dated non-cancelled row outside the window', () => {
    expect(listingDate(OUTSIDE)).toBe('2026-09-13')
    expect(nearestOutOfWindowDate([OUTSIDE, INSIDE], '2026-09-15', '2026-09-21')).toBe('2026-09-13')
    expect(nearestOutOfWindowDate([
      { ...OUTSIDE, mass_date: '2026-08-01' },
      { ...OUTSIDE, id: 2, mass_date: '2026-09-22' },
    ], '2026-09-15', '2026-09-21')).toBe('2026-09-22')
  })

  it('skips cancelled, undated, and in-window rows', () => {
    expect(nearestOutOfWindowDate([
      { ...OUTSIDE, status: 'cancelled' },
      { ...OUTSIDE, id: 2, mass_date: null },
      INSIDE,
    ], '2026-09-15', '2026-09-21')).toBeNull()
    expect(nearestOutOfWindowDate([], '2026-09-15', '2026-09-21')).toBeNull()
  })
})

describe('groupSheetIntentions', () => {
  it('does not invent a day group from an empty week', () => {
    expect(groupSheetIntentions([])).toEqual([])
    expect(groupSheetIntentions(null)).toEqual([])
  })
})

describe('Sacristy sheet empty week', () => {
  it('names the week window and discloses out-of-window book rows without dumping them', async () => {
    stubFetch({ weekly: [], outside: '2026-09-13' })
    renderSheet()

    expect(await screen.findByText(
      'No intentions are scheduled for Tuesday, September 15 – Monday, September 21, 2026.',
    )).toBeInTheDocument()
    expect(screen.queryByText('No intentions are scheduled for this week.')).not.toBeInTheDocument()

    expect(await screen.findByText('The book has intentions outside this week.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Show the week of September 13, 2026/i })).toBeInTheDocument()
    expect(screen.queryByText('OUT-OF-WINDOW SAMPLE')).not.toBeInTheDocument()
    expect(screen.queryByText('The book has intentions waiting without a Mass date.')).not.toBeInTheDocument()
  })

  it('does not disclose when the book is also empty', async () => {
    stubFetch({ weekly: [], outside: null })
    renderSheet()

    expect(await screen.findByText(
      'No intentions are scheduled for Tuesday, September 15 – Monday, September 21, 2026.',
    )).toBeInTheDocument()
    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]))
      expect(urls.some(u => u.includes('/api/mass-intentions/nearest-outside'))).toBe(true)
      expect(urls.some(u => /\/api\/mass-intentions\?limit=50/.test(u))).toBe(false)
    })
    expect(screen.queryByText('The book has intentions outside this week.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show the week of/i })).not.toBeInTheDocument()
    expect(screen.queryByText('The book has intentions waiting without a Mass date.')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Open the book of intentions/i })).not.toBeInTheDocument()
  })

  it('discloses undated waiting without dumping it onto the sheet', async () => {
    stubFetch({ weekly: [], outside: null, undatedWaiting: true })
    renderSheet()

    expect(await screen.findByText(
      'No intentions are scheduled for Tuesday, September 15 – Monday, September 21, 2026.',
    )).toBeInTheDocument()
    expect(await screen.findByText('The book has intentions waiting without a Mass date.')).toBeInTheDocument()
    const book = screen.getByRole('link', { name: /Open the book of intentions/i })
    expect(book).toHaveAttribute('href', '/mass-intentions')
    expect(book.closest('div')?.className ?? '').toMatch(/print:hidden/)
    expect(screen.queryByText('The book has intentions outside this week.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show the week of/i })).not.toBeInTheDocument()
    expect(screen.queryByText('UNDATED SAMPLE')).not.toBeInTheDocument()
  })

  it('keeps the dated-outside jump when undated waiting is also present', async () => {
    stubFetch({ weekly: [], outside: '2026-09-13', undatedWaiting: true })
    renderSheet()

    expect(await screen.findByText('The book has intentions outside this week.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Show the week of September 13, 2026/i })).toBeInTheDocument()
    expect(screen.getByText('The book has intentions waiting without a Mass date.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open the book of intentions/i })).toHaveAttribute('href', '/mass-intentions')
    expect(screen.queryByText('OUT-OF-WINDOW SAMPLE')).not.toBeInTheDocument()
  })

  it('asks nearest-outside, not the first book page', async () => {
    stubFetch({ weekly: [], outside: '2026-10-04' })
    renderSheet()

    expect(await screen.findByRole('button', { name: /Show the week of October 4, 2026/i })).toBeInTheDocument()
    const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('/api/mass-intentions/nearest-outside?start=2026-09-15&end=2026-09-21'))).toBe(true)
    expect(urls.some(u => /\/api\/mass-intentions\?limit=50/.test(u))).toBe(false)
  })

  it('keeps the week window when the book has rows outside it', async () => {
    stubFetch({ weekly: [INSIDE], outside: '2026-09-13' })
    renderSheet()

    expect(await screen.findByText('IN-WINDOW SAMPLE')).toBeInTheDocument()
    expect(screen.queryByText('OUT-OF-WINDOW SAMPLE')).not.toBeInTheDocument()
    expect(screen.queryByText(/No intentions are scheduled/i)).not.toBeInTheDocument()
  })

  it('jumps to the week that holds the out-of-window intention', async () => {
    stubFetch({
      weekly: (start) => (start === '2026-09-12' ? [OUTSIDE] : []),
      outside: (start) => (start === '2026-09-15' ? '2026-09-13' : null),
    })
    renderSheet()

    const jump = await screen.findByRole('button', { name: /Show the week of September 13, 2026/i })
    fireEvent.click(jump)

    expect(await screen.findByText('OUT-OF-WINDOW SAMPLE')).toBeInTheDocument()
    expect(screen.queryByText(/No intentions are scheduled/i)).not.toBeInTheDocument()
    const weeklyStarts = vi.mocked(fetch).mock.calls
      .map(c => String(c[0]))
      .filter(u => u.includes('/api/mass-intentions/weekly'))
      .map(queryStart)
    expect(weeklyStarts).toContain('2026-09-12')
  })

  it('jumps to the Saturday–Friday sheet that holds a mid-week date', async () => {
    stubFetch({
      weekly: (start) => (start === '2026-09-12' ? [{ ...OUTSIDE, mass_date: '2026-09-16' }] : []),
      outside: (start) => (start === '2026-09-15' ? '2026-09-16' : null),
    })
    renderSheet()

    const jump = await screen.findByRole('button', { name: /Show the week of September 16, 2026/i })
    fireEvent.click(jump)

    expect(await screen.findByText('OUT-OF-WINDOW SAMPLE')).toBeInTheDocument()
    const weeklyStarts = vi.mocked(fetch).mock.calls
      .map(c => String(c[0]))
      .filter(u => u.includes('/api/mass-intentions/weekly'))
      .map(queryStart)
    expect(weeklyStarts).toContain('2026-09-12')
    expect(weeklyStarts).not.toContain('2026-09-16')
    expect(weeklyStarts).not.toContain('2026-09-13')
  })
})

const STAMP_AT = '2026-09-26T19:15:00.000Z'
const STAMP_ZONE = 'America/Los_Angeles'
const THREE_ON_SHEET = [
  { ...INSIDE, id: 1, formatted_intention: 'FIRST SAMPLE' },
  { ...INSIDE, id: 2, formatted_intention: 'SECOND SAMPLE' },
  { ...INSIDE, id: 3, formatted_intention: 'THIRD SAMPLE' },
]

describe('sacristy generation stamp', () => {
  afterEach(() => {
    localStorage.removeItem('ochr_locale')
  })

  it('stamps the parish clock, the week, and the intention count, and does not say Printed', async () => {
    const undated = { ...INSIDE, id: 4, mass_date: null, formatted_intention: 'UNDATED SAMPLE' }
    stubFetch({ weekly: [...THREE_ON_SHEET, undated], generatedAt: STAMP_AT, timezone: STAMP_ZONE })
    renderSheet('/mass-intentions/print?start=2026-09-13')
    const footer = await screen.findByTestId('sheet-generation-stamp')
    expect(footer.textContent).toBe(
      'Generated September 26, 2026 at 12:15 PM PDT · Sunday, September 13 – Saturday, September 19, 2026 · 4 intentions · OpenChurch',
    )
    expect(screen.getByText('UNDATED SAMPLE')).toBeInTheDocument()
    expect(footer.textContent).not.toContain('3 intentions')
    expect(footer.className).not.toMatch(/print:hidden/)
    expect(document.body.textContent).not.toMatch(/\bPrinted\b/)
    expect(document.body.textContent).not.toMatch(/\b(issued|emailed|archived)\b/i)
  })

  it('uses the singular when one intention is on the sheet', async () => {
    stubFetch({ weekly: [INSIDE], generatedAt: STAMP_AT, timezone: STAMP_ZONE })
    renderSheet('/mass-intentions/print?start=2026-09-13')
    const footer = await screen.findByTestId('sheet-generation-stamp')
    expect(footer.textContent).toContain('1 intention')
    expect(footer.textContent).not.toContain('intentions')
  })

  it('says when the printed rows are only part of the week', async () => {
    stubFetch({
      weekly: THREE_ON_SHEET,
      generatedAt: STAMP_AT,
      timezone: STAMP_ZONE,
      intentionTotal: 8,
      truncated: true,
    })
    renderSheet('/mass-intentions/print?start=2026-09-13')
    const footer = await screen.findByTestId('sheet-generation-stamp')
    expect(footer.textContent).toContain('3 of 8 intentions')
    expect(footer.textContent).not.toMatch(/· 3 intentions ·/)
  })

  it('counts zero on an empty week', async () => {
    stubFetch({ weekly: [], generatedAt: STAMP_AT, timezone: STAMP_ZONE })
    renderSheet('/mass-intentions/print?start=2026-09-13')
    const footer = await screen.findByTestId('sheet-generation-stamp')
    expect(footer.textContent).toContain('0 intentions')
    expect(footer.textContent).toContain('Sunday, September 13 – Saturday, September 19, 2026')
  })

  it('SPANISH STAMP USES THE LOCALE CLOCK AND DOES NOT SAY IMPRESO', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch({ weekly: THREE_ON_SHEET, generatedAt: STAMP_AT, timezone: STAMP_ZONE })
    renderSheet('/mass-intentions/print?start=2026-09-13')
    const footer = await screen.findByTestId('sheet-generation-stamp')
    expect(footer.textContent).toContain('Generado el 26 de septiembre de 2026 a las 12:15 GMT-7')
    expect(footer.textContent).toContain('13 de septiembre')
    expect(footer.textContent).toContain('19 de septiembre de 2026')
    expect(footer.textContent).toContain('3 intenciones')
    expect(footer.textContent).not.toMatch(/\bImpreso\b/)
    expect(footer.textContent).not.toMatch(/12:15\s*PM/)
    expect(document.body.textContent).not.toMatch(/\bPrinted\b/)
  })

  it('does not show Printed while the week is still loading', async () => {
    let releaseWeekly
    const weeklyGate = new Promise((resolve) => { releaseWeekly = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
      if (u.includes('/api/mass-intentions/weekly')) {
        await weeklyGate
        return ok({
          intentions: THREE_ON_SHEET,
          generated_at: STAMP_AT,
          timezone: STAMP_ZONE,
        })
      }
      if (u.includes('/api/mass-intentions/nearest-outside')) {
        return ok({ date: null, undated_waiting: false, undated_waiting_count: 0 })
      }
      return ok({})
    }))
    renderSheet('/mass-intentions/print?start=2026-09-13')
    expect(screen.queryByTestId('sheet-generation-stamp')).toBeNull()
    expect(document.body.textContent).not.toMatch(/\bPrinted\b/)
    releaseWeekly()
    const footer = await screen.findByTestId('sheet-generation-stamp')
    expect(footer.textContent).toContain('3 intentions')
    expect(document.body.textContent).not.toMatch(/\bPrinted\b/)
  })

  it('generationClock uses the parish zone and the active language', () => {
    expect(generationClock(STAMP_AT, STAMP_ZONE, 'en-US')).toEqual({
      date: 'September 26, 2026', time: '12:15 PM', tz: 'PDT',
    })
    const es = generationClock(STAMP_AT, STAMP_ZONE, 'es')
    expect(es).toEqual({
      date: '26 de septiembre de 2026', time: '12:15', tz: 'GMT-7',
    })
    expect(generationClock(STAMP_AT, 'America/New_York', 'en-US')).toEqual({
      date: 'September 26, 2026', time: '3:15 PM', tz: 'EDT',
    })
    expect(resolvedSheetTimeZone('Not/AZone')).toBe('UTC')
    expect(resolvedSheetTimeZone('')).toBe('UTC')
    expect(generationClock('not-a-date', STAMP_ZONE, 'en-US')).toBeNull()
    const jsx = stripComments(SHEET_SRC)
    expect(SHEET_SRC).toMatch(/toLocaleTimeString\(locale/)
    expect(jsx).not.toMatch(/['"]AM['"]/)
    expect(jsx).not.toMatch(/['"]PM['"]/)
    expect(jsx).not.toMatch(/sheet\.printed/)
    expect(jsx).not.toMatch(/\bPrinted\b/)
    expect(jsx).not.toMatch(/\bImpreso\b/)
  })
})

describe('sundayStartOf', () => {
  it('returns the Sunday that names the week', () => {
    expect(sundayStartOf('2026-09-16')).toBe('2026-09-13')
    expect(sundayStartOf('2026-09-13')).toBe('2026-09-13')
    expect(sundayStartOf('2026-09-19')).toBe('2026-09-13')
    expect(sundayStartOf('2026-09-20')).toBe('2026-09-20')
    expect(sundayStartOf(new Date(2026, 8, 16))).toBe('2026-09-13')
  })
})

describe('Sacristy print chrome at phone width (OC-READY-02-001)', () => {
  // jsdom does not layout. This pins the contract the 390×844 overflow
  // depends on — wrap + min-w-0, no unprefixed min-w-[13rem], Print never
  // shrinks. Headed measurement stays with Mercury.
  afterEach(() => {
    localStorage.removeItem('ochr_locale')
  })

  it('lets the week cluster wrap so Print stays whole', async () => {
    stubFetch({ weekly: [INSIDE] })
    renderSheet('/mass-intentions/print?start=2026-09-13')

    const print = await screen.findByRole('button', { name: /^print$/i })
    expect(print.textContent).toMatch(/^\s*Print\s*$/)
    expect(print.className).toMatch(/shrink-0/)
    expect(print.className).not.toMatch(/truncate|ellipsis/)

    const chrome = screen.getByTestId('sheet-week-chrome')
    expect(chrome.contains(print)).toBe(true)
    expect(chrome.className).toMatch(/flex-wrap/)
    expect(chrome.className).toMatch(/min-w-0/)
    expect(chrome.className).toMatch(/max-w-full/)

    const range = screen.getByTestId('sheet-week-range')
    expect(chrome.contains(range)).toBe(true)
    expect(range.className).toMatch(/min-w-0/)
    expect(range.className).toMatch(/sm:min-w-\[13rem\]/)
    expect(range.className).not.toMatch(/(^|\s)min-w-\[13rem\]/)

    const honesty = screen.getByTestId('sheet-print-not-emailed')
    expect(honesty.textContent).toMatch(/print or save as PDF only/i)
    expect(honesty.textContent).toMatch(/does not email/i)
  })

  it('keeps the Spanish Print label whole in the same wrapping chrome', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch({ weekly: [INSIDE] })
    renderSheet('/mass-intentions/print?start=2026-09-13')

    const print = await screen.findByRole('button', { name: /^imprimir$/i })
    expect(print.textContent).toMatch(/^\s*Imprimir\s*$/)
    expect(print.className).toMatch(/shrink-0/)
    expect(screen.getByTestId('sheet-week-chrome').contains(print)).toBe(true)
    expect(screen.getByTestId('sheet-print-not-emailed').textContent).toMatch(/no la envía por correo/i)
    localStorage.removeItem('ochr_locale')
  })
})

describe('vigil week default', () => {
  const LA = 'America/Los_Angeles'

  function weeklyUrls() {
    return vi.mocked(fetch).mock.calls.map(c => String(c[0])).filter(u => u.includes('/api/mass-intentions/weekly'))
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    sheetAuth.timezone = LA
  })
  afterEach(() => {
    vi.useRealTimers()
    sheetAuth.timezone = 'UTC'
  })

  it('Friday afternoon opens the coming Sunday together with its vigil', async () => {
    // 2026-10-02 15:00 PDT. The old Sunday-start window was Sep 27–Oct 3.
    vi.setSystemTime(new Date('2026-10-02T22:00:00.000Z'))
    stubFetch({ weekly: [] })
    renderSheet('/mass-intentions/print')

    expect(await screen.findByText(
      'No intentions are scheduled for Saturday, October 3 – Friday, October 9, 2026.',
    )).toBeInTheDocument()
    const urls = weeklyUrls()
    expect(urls.some(u => u.includes('start=2026-10-03&end=2026-10-09'))).toBe(true)
    expect(urls.some(u => u.includes('start=2026-09-27'))).toBe(false)
    expect(urls.some(u => u.includes('start=2026-10-04'))).toBe(false)
  })

  it('Saturday evening stays on that same weekend', async () => {
    // 2026-10-03 21:00 PDT. Still Saturday in the parish; Sunday in UTC.
    vi.setSystemTime(new Date('2026-10-04T04:00:00.000Z'))
    stubFetch({ weekly: [] })
    renderSheet('/mass-intentions/print')

    expect(await screen.findByText(
      'No intentions are scheduled for Saturday, October 3 – Friday, October 9, 2026.',
    )).toBeInTheDocument()
    expect(weeklyUrls().some(u => u.includes('start=2026-10-03&end=2026-10-09'))).toBe(true)
  })

  it('Sunday stays on the weekend already underway', async () => {
    vi.setSystemTime(new Date('2026-10-04T22:00:00.000Z'))
    stubFetch({ weekly: [] })
    renderSheet('/mass-intentions/print')

    expect(await screen.findByText(
      'No intentions are scheduled for Saturday, October 3 – Friday, October 9, 2026.',
    )).toBeInTheDocument()
    expect(weeklyUrls().some(u => u.includes('start=2026-10-03&end=2026-10-09'))).toBe(true)
  })

  it('Monday looks forward to the next Sunday and its vigil', async () => {
    vi.setSystemTime(new Date('2026-10-05T22:00:00.000Z'))
    stubFetch({ weekly: [] })
    renderSheet('/mass-intentions/print')

    expect(await screen.findByText(
      'No intentions are scheduled for Saturday, October 10 – Friday, October 16, 2026.',
    )).toBeInTheDocument()
    const urls = weeklyUrls()
    expect(urls.some(u => u.includes('start=2026-10-10&end=2026-10-16'))).toBe(true)
    expect(urls.some(u => u.includes('start=2026-10-03'))).toBe(false)
  })

  it('uses the parish civil date when UTC has already turned the page', async () => {
    // Sunday 2026-10-04 21:00 PDT is Monday 2026-10-05 04:00 UTC.
    vi.setSystemTime(new Date('2026-10-05T04:00:00.000Z'))
    stubFetch({ weekly: [] })
    renderSheet('/mass-intentions/print')

    expect(await screen.findByText(
      'No intentions are scheduled for Saturday, October 3 – Friday, October 9, 2026.',
    )).toBeInTheDocument()
    expect(weeklyUrls().some(u => u.includes('start=2026-10-03&end=2026-10-09'))).toBe(true)
    expect(weeklyUrls().some(u => u.includes('start=2026-10-10'))).toBe(false)
  })

  it('honors an explicit mid-week start as a literal 7-day window', async () => {
    vi.setSystemTime(new Date('2026-10-02T22:00:00.000Z'))
    stubFetch({ weekly: [] })
    renderSheet('/mass-intentions/print?start=2026-09-16')

    expect(await screen.findByText(
      'No intentions are scheduled for Wednesday, September 16 – Tuesday, September 22, 2026.',
    )).toBeInTheDocument()
    expect(weeklyUrls().some(u => u.includes('start=2026-09-16&end=2026-09-22'))).toBe(true)
  })

  it('moves an explicit window by seven days', async () => {
    vi.setSystemTime(new Date('2026-10-02T22:00:00.000Z'))
    stubFetch({ weekly: [] })
    renderSheet('/mass-intentions/print?start=2026-10-03')

    expect(await screen.findByText(
      'No intentions are scheduled for Saturday, October 3 – Friday, October 9, 2026.',
    )).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    expect(await screen.findByText(
      'No intentions are scheduled for Saturday, October 10 – Friday, October 16, 2026.',
    )).toBeInTheDocument()
    expect(weeklyUrls().some(u => u.includes('start=2026-10-10&end=2026-10-16'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    expect(await screen.findByText(
      'No intentions are scheduled for Saturday, October 3 – Friday, October 9, 2026.',
    )).toBeInTheDocument()
  })

  it('an impossible start falls back to the vigil week instead of the error screen', async () => {
    // Friday 2026-10-02 15:00 PDT. 2026-02-31, 2026-13-01, and 0050-01-01
    // match YYYY-MM-DD, then sheetWeekEnd returns null and localDate throws.
    vi.setSystemTime(new Date('2026-10-02T22:00:00.000Z'))
    stubFetch({ weekly: [] })
    for (const bad of ['2026-02-31', '2026-13-01', '0050-01-01']) {
      const view = render(
        <MemoryRouter initialEntries={[`/mass-intentions/print?start=${bad}`]}>
          <LocaleProvider>
            <ErrorBoundary>
              <Routes>
                <Route path="/mass-intentions/print" element={<SacristySheet />} />
              </Routes>
            </ErrorBoundary>
          </LocaleProvider>
        </MemoryRouter>,
      )
      expect(screen.queryByRole('heading', { name: STRINGS.en['error.title'] })).toBeNull()
      expect(await screen.findByText(
        'No intentions are scheduled for Saturday, October 3 – Friday, October 9, 2026.',
      )).toBeInTheDocument()
      const urls = weeklyUrls()
      const latest = urls[urls.length - 1]
      expect(latest, bad).toContain('start=2026-10-03&end=2026-10-09')
      expect(latest, bad).not.toContain(bad)
      expect(screen.getByTestId('sheet-ignored-start').textContent).toMatch(/shown as a week/i)
      view.unmount()
    }
  })

  it('a start whose week would enter year 10000 falls back instead of crashing', async () => {
    // 9999-12-28 is a real day. sheetWeekEnd rolls to 10000-01-03 and
    // returns null, and localDate then calls null.split.
    vi.setSystemTime(new Date('2026-10-02T22:00:00.000Z'))
    stubFetch({ weekly: [] })
    renderGuarded('/mass-intentions/print?start=9999-12-28')
    expect(screen.queryByRole('heading', { name: STRINGS.en['error.title'] })).toBeNull()
    expect(await screen.findByText(
      'No intentions are scheduled for Saturday, October 3 – Friday, October 9, 2026.',
    )).toBeInTheDocument()
    const latest = weeklyUrls().at(-1)
    expect(latest).toContain('start=2026-10-03&end=2026-10-09')
    expect(latest).not.toContain('9999')
    expect(screen.getByTestId('sheet-ignored-start').textContent).toMatch(/shown as a week/i)
  })

  it('Next from 9999-12-24 does not step into an unrepresentable week', async () => {
    vi.setSystemTime(new Date('2026-10-02T22:00:00.000Z'))
    stubFetch({ weekly: [] })
    renderGuarded('/mass-intentions/print?start=9999-12-24')
    const label = 'No intentions are scheduled for Friday, December 24 – Thursday, December 30, 9999.'
    expect(await screen.findByText(label)).toBeInTheDocument()
    const next = screen.getByRole('button', { name: 'Next week' })
    fireEvent.click(next)
    expect(screen.queryByRole('heading', { name: STRINGS.en['error.title'] })).toBeNull()
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(weeklyUrls().some(u => u.includes('start=9999-12-31'))).toBe(false)
    expect(next).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous week' })).toBeEnabled()
  })
})

describe('Sacristy week chevron aria is translated (POLISH-L0-02)', () => {
  afterEach(() => {
    localStorage.removeItem('ochr_locale')
  })

  it('ENGLISH PREV/NEXT USE t() COPY', async () => {
    stubFetch({ weekly: [INSIDE] })
    renderSheet('/mass-intentions/print?start=2026-09-13')
    expect(await screen.findByRole('button', { name: STRINGS.en['sheet.prevWeek'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['sheet.nextWeek'] })).toBeInTheDocument()
  })

  it('SPANISH PREV/NEXT ARE SPANISH — NOT THE ENGLISH ARIA', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch({ weekly: [INSIDE] })
    renderSheet('/mass-intentions/print?start=2026-09-13')
    expect(await screen.findByRole('button', { name: STRINGS.es['sheet.prevWeek'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['sheet.nextWeek'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['sheet.prevWeek'] })).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.en['sheet.nextWeek'] })).toBeNull()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN week aria', () => {
    const jsx = stripComments(SHEET_SRC)
    for (const key of SHEET_WEEK_KEYS) {
      expect(SHEET_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(SHEET_SRC).toMatch(/useLocale\(/)
    for (const phrase of HARD_EN_WEEK_ARIA) {
      expect(jsx, `JSX must not hard-code aria ${JSON.stringify(phrase)}`).not.toMatch(
        new RegExp(`aria-label=["']${phrase}["']`),
      )
    }
    expect(STRINGS.en['sheet.prevWeek']).toBe('Previous week')
    expect(STRINGS.en['sheet.nextWeek']).toBe('Next week')
    expect(STRINGS.es['sheet.prevWeek']).toMatch(/semana anterior/i)
    expect(STRINGS.es['sheet.nextWeek']).toMatch(/semana siguiente/i)
  })
})

describe('Sacristy weekly load failure is localized and does not print (GJ1-L2-05)', () => {
  afterEach(() => {
    localStorage.removeItem('ochr_locale')
  })

  it('ENGLISH WEEKLY FAILURE USES t() COPY AND STAYS OFF THE PAPER', async () => {
    stubFetch({ weeklyStatus: 500 })
    renderSheet('/mass-intentions/print?start=2026-09-13')

    const banner = await screen.findByTestId('sheet-load-failed')
    expect(banner.textContent).toBe(STRINGS.en[SHEET_LOAD_KEY])
    expect(banner.textContent).toMatch(/nothing was lost/i)
    expect(banner.textContent).not.toMatch(/\b500\b|error|fail/i)
    expect(banner.className).toMatch(/print:hidden/)
    expect(screen.getByTestId('sheet-paper').className).toMatch(/print:hidden/)
    expect(screen.queryByRole('button', { name: /^print$/i })).toBeNull()
    expect(screen.queryByText(/No intentions are scheduled/i)).not.toBeInTheDocument()
  })

  it('SPANISH WEEKLY FAILURE IS SPANISH — NOT THE ENGLISH SENTENCE', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch({ weeklyStatus: 500 })
    renderSheet('/mass-intentions/print?start=2026-09-13')

    const banner = await screen.findByTestId('sheet-load-failed')
    expect(banner.textContent).toBe(STRINGS.es[SHEET_LOAD_KEY])
    expect(banner.textContent).not.toBe(STRINGS.en[SHEET_LOAD_KEY])
    expect(banner.textContent).toMatch(/no se perdió nada/i)
    expect(banner.textContent).not.toMatch(/couldn't load this week's intentions/i)
    expect(banner.className).toMatch(/print:hidden/)
    expect(screen.queryByRole('button', { name: /^imprimir$/i })).toBeNull()
    localStorage.removeItem('ochr_locale')
  })

  it('i18n strings and the component cannot reintroduce a hard-EN weekly failure', () => {
    const jsx = stripComments(SHEET_SRC)
    expect(SHEET_SRC).toMatch(/t\('sheet\.loadFailed'\)/)
    expect(STRINGS.en[SHEET_LOAD_KEY]).toBe(HARD_EN_LOAD)
    expect(STRINGS.es[SHEET_LOAD_KEY]).toBeTruthy()
    expect(STRINGS.es[SHEET_LOAD_KEY]).not.toBe(STRINGS.en[SHEET_LOAD_KEY])
    expect(jsx).not.toMatch(/Couldn't load this week's intentions/)
    expect(jsx).not.toMatch(/setError\(err\.message\)/)
  })
})

describe('Sacristy Mass time follows the active language (GJ1-L2-05)', () => {
  afterEach(() => {
    localStorage.removeItem('ochr_locale')
  })

  it('ENGLISH NINE O\'CLOCK USES THE ENGLISH MERIDIAN', async () => {
    stubFetch({ weekly: [{ ...INSIDE, mass_title: 'Daily Mass', mass_time: '09:00:00' }] })
    renderSheet('/mass-intentions/print?start=2026-09-13')
    expect(await screen.findByText(/Daily Mass,\s*9:00\s*AM/i)).toBeInTheDocument()
  })

  it('SPANISH NINE O\'CLOCK IS NOT THE HARD-EN AM/PM PAIR', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch({ weekly: [{ ...INSIDE, mass_title: 'Daily Mass', mass_time: '09:00:00' }] })
    renderSheet('/mass-intentions/print?start=2026-09-13')
    const en = fmtTime('09:00:00', 'en-US')
    const es = fmtTime('09:00:00', 'es')
    expect(es).toBeTruthy()
    expect(es).not.toBe(en)
    expect(await screen.findByText(new RegExp(`Daily Mass,\\s*${es.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeInTheDocument()
    expect(screen.queryByText(/Daily Mass,\s*9:00\s*AM/i)).toBeNull()
    localStorage.removeItem('ochr_locale')
  })

  it('fmtTime uses toLocaleTimeString — hard-coded AM/PM goes red', () => {
    const jsx = stripComments(SHEET_SRC)
    expect(SHEET_SRC).toMatch(/toLocaleTimeString\(dateLocale/)
    expect(jsx).not.toMatch(/['"]AM['"]/)
    expect(jsx).not.toMatch(/['"]PM['"]/)
    expect(fmtTime('09:00:00', 'en-US')).toMatch(/9:00/)
    expect(fmtTime('21:30:00', 'en-US')).toMatch(/9:30/)
    expect(fmtTime(null)).toBeNull()
  })
})

// FAILURE-L2-15 HOLD: a non-numeric stipend ("nope") rendered `$NaN` on the
// printed week. This probe goes red if that string comes back.
describe('Sacristy offering amount is never $NaN', () => {
  function stipendText() {
    return screen.queryAllByTestId('sheet-stipend').map(el => el.textContent)
  }

  it('fmtSheetStipend never returns the $NaN string', () => {
    for (const v of [null, undefined, '', 'nope', Number.NaN, Infinity, -Infinity, {}, 'NaN']) {
      const out = fmtSheetStipend(v)
      expect(out == null || out === '—', JSON.stringify(v)).toBe(true)
      expect(String(out), JSON.stringify(v)).not.toContain('NaN')
    }
    expect(fmtSheetStipend(10)).toBe('$10.00')
    expect(fmtSheetStipend('10.5')).toBe('$10.50')
    expect(fmtSheetStipend(0)).toBe('$0.00')
    expect(fmtSheetStipend(null)).toBeNull()
    expect(fmtSheetStipend('')).toBeNull()
    expect(fmtSheetStipend('nope')).toBe('—')
  })

  it('refuses malformed values without inventing money', () => {
    for (const v of [true, false, [], {}, '-5', '1e2', ' 10.00 ', 1e100, -5]) {
      expect(fmtSheetStipend(v), String(v)).toBe('—')
    }
    expect(fmtSheetStipend('   ')).toBeNull()
    expect(fmtSheetStipend('0.00')).toBe('$0.00')
    expect(fmtSheetStipend('10.50')).toBe('$10.50')
  })

  it('A NON-NUMERIC OFFERING IS NOT THE STRING $NaN', async () => {
    stubFetch({
      weekly: [
        { ...INSIDE, id: 21, formatted_intention: 'GARBLED OFFERING', stipend: 'nope' },
        { ...INSIDE, id: 22, formatted_intention: 'NAN OFFERING', stipend: Number.NaN },
      ],
    })
    renderSheet('/mass-intentions/print?start=2026-09-13')

    expect(await screen.findByText('GARBLED OFFERING')).toBeInTheDocument()
    expect(screen.getByText('NAN OFFERING')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('$NaN')
    expect(document.body.textContent).not.toMatch(/NaN/)
    expect(stipendText()).toEqual(['—', '—'])
  })

  it('A FINITE OFFERING STILL PRINTS DOLLARS AND CENTS, INCLUDING ZERO', async () => {
    stubFetch({
      weekly: [
        { ...INSIDE, id: 31, formatted_intention: 'TEN OFFERING', stipend: 10 },
        { ...INSIDE, id: 32, formatted_intention: 'STRING OFFERING', stipend: '10.50' },
        { ...INSIDE, id: 33, formatted_intention: 'ZERO OFFERING', stipend: 0 },
      ],
    })
    renderSheet('/mass-intentions/print?start=2026-09-13')

    expect(await screen.findByText('TEN OFFERING')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('$NaN')
    expect(document.body.textContent).toContain('$10.00')
    expect(document.body.textContent).toContain('$10.50')
    expect(document.body.textContent).toContain('$0.00')
    expect(stipendText()).toEqual(['$10.00', '$10.50', '$0.00'])
  })

  it('a reopened stamped row is labeled previously recorded fulfilment', async () => {
    stubFetch({
      weekly: [{
        ...INSIDE,
        id: 51,
        formatted_intention: 'REOPENED STAMP',
        status: 'scheduled',
        fulfilment_label: 'previously recorded fulfilment',
      }],
    })
    renderSheet('/mass-intentions/print?start=2026-09-13')
    expect(await screen.findByText('previously recorded fulfilment')).toBeInTheDocument()
    expect(screen.queryByText('fulfilled')).not.toBeInTheDocument()
    expect(screen.queryByText('Fulfilled')).not.toBeInTheDocument()
  })

  it('A MISSING OFFERING STAYS OFF THE LINE — NOT $0.00 AND NOT $NaN', async () => {
    stubFetch({
      weekly: [
        { ...INSIDE, id: 41, formatted_intention: 'NULL OFFERING', stipend: null },
        { ...INSIDE, id: 42, formatted_intention: 'BLANK OFFERING', stipend: '' },
        { ...INSIDE, id: 43, formatted_intention: 'ABSENT OFFERING' },
      ],
    })
    renderSheet('/mass-intentions/print?start=2026-09-13')

    expect(await screen.findByText('NULL OFFERING')).toBeInTheDocument()
    expect(screen.getByText('BLANK OFFERING')).toBeInTheDocument()
    expect(screen.getByText('ABSENT OFFERING')).toBeInTheDocument()
    expect(screen.queryByTestId('sheet-stipend')).toBeNull()
    expect(document.body.textContent).not.toContain('$NaN')
    expect(document.body.textContent).not.toContain('$0.00')
  })
})
