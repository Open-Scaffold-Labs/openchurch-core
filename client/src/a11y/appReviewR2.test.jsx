// App Review R2 (Beacon, 2026-10-26) — the items R2 found PARTIAL or NOT
// FIXED at e6cf1d24: Preferences "Push on this device" still English, EIN
// help hard-coded English, raw IANA timezone labels, Register FAB overlap
// at 200% / Place clipped at 300%, and Schedule titles truncated at 200%.
// Layout items are CSS-only, so they are pinned at the source level here;
// jsdom does not lay out. Visual re-measure is Beacon's (R3).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import PushSubscriptionToggle from '../components/PushSubscriptionToggle'
import OrgSettings from '../pages/OrgSettings'
import { parishTimeZoneLabel } from '../utils/parishTimeZone'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Rector', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', timezone: 'UTC' } },
    updateUser: vi.fn(),
    token: 't', loading: false,
  }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8')
const ok = (b, status = 200) => ({ ok: status < 300, status, json: async () => b })
const es = (k) => STRINGS.es[k]

function installPushBrowser() {
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(async () => 'granted') })
  vi.stubGlobal('PushManager', function PushManager() {})
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn() } }) },
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  localStorage.setItem('ochr_locale', 'es')
})
afterEach(() => { delete navigator.serviceWorker })

describe('R2 finding 4 — Push on this device, Spanish', () => {
  const mountPush = () => render(<LocaleProvider><ToastProvider><PushSubscriptionToggle /></ToastProvider></LocaleProvider>)

  it('the no-VAPID card is Spanish: heading, row label and the VAPID message', async () => {
    installPushBrowser()
    vi.stubGlobal('fetch', vi.fn(async () => ok({ publicKey: null })))
    mountPush()
    expect(await screen.findByRole('heading', { name: es('push.title') })).toBeInTheDocument()
    expect(screen.getByText(es('push.rowLabel'))).toBeInTheDocument()
    expect(screen.getByText(es('push.unsetBody'))).toBeInTheDocument()
    expect(screen.queryByText(/Push on this device/)).not.toBeInTheDocument()
    expect(screen.queryByText(/isn't configured/)).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: es('push.enableAria') })).toBeDisabled()
  })

  it('the interactive card is Spanish', async () => {
    installPushBrowser()
    vi.stubGlobal('fetch', vi.fn(async () => ok({ publicKey: 'BEl0123456789abcdef' })))
    mountPush()
    expect(await screen.findByText(es('push.offBody'))).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: es('push.enableAria') })).toBeEnabled()
  })

  it('the unsupported-browser card is Spanish', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({})))
    mountPush()
    expect(await screen.findByText(es('push.unsupported'))).toBeInTheDocument()
  })

  it('every push.* key exists in both locales, non-empty, Spanish differs, vars match', () => {
    const keys = Object.keys(STRINGS.en).filter(k => k.startsWith('push.'))
    expect(keys.length).toBeGreaterThanOrEqual(17)
    const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
    for (const k of keys) {
      expect(STRINGS.es[k], k).toBeTruthy()
      expect(STRINGS.es[k], k).not.toBe(STRINGS.en[k])
      expect(vars(STRINGS.es[k]), k).toEqual(vars(STRINGS.en[k]))
    }
    const src = read('components/PushSubscriptionToggle.jsx').replace(/^\s*\/\/.*$/gm, '')
    for (const lit of ['Push on this device<', 'VAPID keys this toggle', 'You blocked notifications', "aren't supported in this browser", "'Enable push on this device'"]) {
      expect(src, lit).not.toContain(lit)
    }
  })
})

describe('R2 finding 10 — EIN help and timezone labels', () => {
  const ORG = {
    id: 1, name: 'St Test', slug: 'st-test', address: '', tax_id: '',
    signatory_name: '', signatory_title: '', statement_letterhead: '',
    tagline: '', about: '', service_times: '', page_published: false,
    reminder_lead_hours: 24, timezone: 'America/Los_Angeles', locale: 'es',
  }
  const mountOrg = () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.endsWith('/api/organization')) return ok(ORG)
      if (u.includes('/api/affiliation')) return ok({ affiliation: null })
      if (u.includes('/api/ai/provider')) return ok({ source: 'platform' })
      if (u.includes('/api/parish-feasts')) return ok({ feasts: [] })
      return ok({})
    }))
    return render(
      <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider><OrgSettings /></ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>,
    )
  }

  it('the EIN help text follows the locale', async () => {
    mountOrg()
    expect(await screen.findByText(es('orgs.f.tax_id.hint'))).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['orgs.f.tax_id.hint'])).not.toBeInTheDocument()
    expect(read('pages/OrgSettings.jsx')).not.toMatch(/legalHint/)
  })

  it('timezone options show a localized name; the value stays the IANA id', async () => {
    mountOrg()
    const select = await screen.findByLabelText(es('org.tz.label'))
    expect(select).toHaveValue('America/Los_Angeles')
    const la = within(select).getAllByRole('option').find(o => o.value === 'America/Los_Angeles')
    expect(la.textContent).toBe(parishTimeZoneLabel('America/Los_Angeles', 'es'))
    expect(la.textContent).not.toBe('America/Los_Angeles')
    expect(la.textContent).toMatch(/Los Angeles/)
    const raw = within(select).getAllByRole('option').filter(o => o.textContent === o.value && o.value.includes('/'))
    expect(raw.map(o => o.value)).toEqual([])
  })

  it('parishTimeZoneLabel: English and Spanish names, city kept, safe fallback', () => {
    expect(parishTimeZoneLabel('America/Los_Angeles', 'en-US')).toMatch(/Pacific.*Los Angeles/)
    expect(parishTimeZoneLabel('America/Los_Angeles', 'es')).toMatch(/Pacífico.*Los Angeles/)
    expect(parishTimeZoneLabel('UTC', 'en-US')).toMatch(/Coordinated Universal Time/)
    expect(parishTimeZoneLabel('Not/AZone', 'en-US')).toBe('Not/AZone')
    expect(parishTimeZoneLabel('', 'en-US')).toBe('')
  })
})

describe('R2 finding 7 — layout pins (CSS only; visual check is R3)', () => {
  it('Register actions keep a FAB-width right gutter and the table reflows on narrow screens, not in print', () => {
    const src = read('pages/SacramentalRegister.jsx')
    expect(src).toMatch(/<th className="sticky right-0 [^"]*pr-16/)
    expect(src).toMatch(/<td className="sticky right-0 [^"]*pr-16[^"]*reflow:static/)
    expect(src).toMatch(/<table className="[^"]*reflow:block/)
    expect(src).toMatch(/data-label=\{t\('register\.place'\)\}/)
    const tw = readFileSync(join(HERE, '..', '..', 'tailwind.config.js'), 'utf8')
    // R3: cards below 1280 CSS px (sidebar + 7 columns) so 200%/250% zoom reflows too.
    expect(tw).toMatch(/reflow:\s*\{\s*raw:\s*'screen and \(max-width: 1279\.98px\)'/)
  })

  it('Schedule tile titles wrap at word boundaries, use the lines the tile has, never break mid-word', () => {
    const src = read('pages/Schedule.jsx')
    expect(src).not.toMatch(/<span className="truncate">\{event\.title\}<\/span>/)
    expect(src).not.toMatch(/overflow-wrap:anywhere/)
    expect(src).toMatch(/\[word-break:normal\] \[overflow-wrap:break-word\] hyphens-auto/)
    expect(src).toMatch(/WebkitLineClamp: titleLines/)
  })

  it('Schedule agenda/grid are not squeezed into a sliver of nested scroll (R3)', () => {
    const src = read('pages/Schedule.jsx')
    expect(src).toMatch(/data-testid="week-grid" className="[^"]*min-h-\[24rem\]/)
    expect(src).toMatch(/data-testid="day-agenda" className="[^"]*flex-\[1_0_auto\]/)
    expect(src).not.toMatch(/flex-1 overflow-y-auto p-3 space-y-2/)
    // R4: week grid only from 1440 CSS px (at exactly 1280 titles still clamped); agenda below.
    expect(src).toMatch(/data-testid="week-grid" className="[^"]*hidden weekgrid:flex/)
    expect(src).toMatch(/data-testid="day-agenda" className="weekgrid:hidden /)
    expect(src).not.toMatch(/\bxl:(flex|hidden)\b/)
    const tw = readFileSync(join(HERE, '..', '..', 'tailwind.config.js'), 'utf8')
    expect(tw).toMatch(/weekgrid:\s*'1440px'/)
    // Last agenda card scrolls clear of the floating assistant button.
    expect(src).toMatch(/className="flex-1 p-3 pb-24 space-y-2"/)
  })

  it('Schedule week-grid tiles are tall enough that the time never clips (R4)', () => {
    const src = read('pages/Schedule.jsx')
    expect(src).toMatch(/const MIN_TILE_HEIGHT = 56/)
    expect(src).toMatch(/Math\.max\(\(\(endMins - startMins\) \/ 60\) \* HOUR_HEIGHT, MIN_TILE_HEIGHT \+ intentionH\)/)
    // The time line is always rendered (no short-tile branch that hid it).
    expect(src).toMatch(/<p data-testid="tile-time"/)
    expect(src).not.toMatch(/\{!short && \(/)
  })

  it('Register search: own row on narrow screens, shorter ES placeholder, full accessible name (R4)', () => {
    const src = read('pages/SacramentalRegister.jsx')
    expect(src).toMatch(/relative flex-1 min-w-\[12rem\] reflow:basis-full/)
    expect(src).toMatch(/placeholder=\{t\('register\.searchPlaceholder'\)\}/)
    expect(src).toMatch(/aria-label=\{t\('register\.search'\)\}/)
    const strings = read('i18n/strings.js')
    expect(strings).toMatch(/'register\.searchPlaceholder': 'Nombre, ministro, lugar o n\.º de certificado'/)
  })
})
