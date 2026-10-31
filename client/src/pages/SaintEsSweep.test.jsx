// Saint ES sweep (SP-128, SP-137/138/140-145/147): screens that still showed
// English in a Spanish session. Each page is rendered in EN and in ES; the
// Spanish render must show the Spanish string and not the English one.
// Stored data tokens (donation category/method, task category, plan copy)
// stay English in the data and are translated only on screen.
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { enT } from '../i18n/sweepStrings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Checkin from './Checkin'
import Donations, { catLabel, methodLabel, cashCountVerificationLabel } from './Donations'
import Billing, { planText } from './Billing'
import { PRICING_VISIBLE, betaBillingSubtitle } from '../config/pricing'
import OrgSettings from './OrgSettings'
import Events from './Events'
import SacramentalRegister from './SacramentalRegister'
import { taskCategoryLabel, sampleParts } from './Dashboard'
import HelpPanel, { moduleName, localizedByIndex } from '../components/HelpPanel'
import { TIPS } from '../data/helpContent'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', slug: 'st-test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true, updateUser: () => {},
  }),
}))

const { en, es } = STRINGS
const tOf = (dict) => (k, vars) => {
  let s = dict[k] ?? en[k] ?? k
  if (vars) for (const [a, b] of Object.entries(vars)) s = s.replaceAll(`{${a}}`, String(b))
  return s
}
const esT = tOf(es)
const ok = (body) => ({ ok: true, status: 200, json: async () => body })

let calendar = []
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/billing')) return ok({ planDetails: { id: 'free', name: 'Parish', description: 'The free plan', price: 0 }, availablePlans: [], billing_status: 'active' })
    if (u.includes('/api/funds')) return ok({ funds: [], provider: 'stub' })
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [], needs_attention: [] })
    if (u.includes('/api/donations/summary')) return ok({ donor_count: 0, total: 0 })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/events')) return ok([])
    if (u.includes('/api/calendar?')) return ok(calendar)
    if (u.includes('/api/rooms')) return ok({ rooms: [] })
    return ok([])
  }))
}

function mount(ui, locale) {
  if (locale === 'es') localStorage.setItem('ochr_locale', 'es')
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => { localStorage.removeItem('ochr_locale'); calendar = []; stubFetch() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('every sweep key exists in both locales', () => {
  const prefixes = ['ck.', 'don.', 'bill.', 'orgs.', 'dash.cat.', 'dash.sample.', 'ev.col.', 'ev.searchPh', 'help.tip.', 'help.role.', 'reg.filterSac']
  it('no sweep key is English-only', () => {
    const keys = Object.keys(en).filter((k) => prefixes.some((p) => k.startsWith(p)))
    expect(keys.length).toBeGreaterThan(250)
    expect(keys.filter((k) => !es[k])).toEqual([])
  })
})

describe.each([['en', en], ['es', es]])('%s render', (locale, d) => {
  const other = locale === 'es' ? en : es
  it('SP-141 Check-in empty window', async () => {
    mount(<Checkin />, locale)
    expect(await screen.findByText(d['ck.noServices'])).toBeInTheDocument()
    expect(screen.queryByText(other['ck.noServices'])).toBeNull()
  })
  it('SP-141 Check-in', async () => {
    const today = new Date().toISOString().slice(0, 10)
    calendar = [{ id: 17, title: 'Sunday Mass', date: `${today}T07:00:00.000Z`, start_time: '10:30' }]
    mount(<Checkin />, locale)
    expect(await screen.findByRole('heading', { name: d['ck.title'] })).toBeInTheDocument()
    expect(screen.getByText(d['ck.subtitle'])).toBeInTheDocument()
    expect(screen.queryByText(other['ck.subtitle'])).toBeNull()
  })
  it('SP-142/143 Donations and Cash Count', async () => {
    mount(<Donations />, locale)
    expect(await screen.findByRole('heading', { name: d['don.title'] })).toBeInTheDocument()
    expect(screen.getByText(d['don.subtitle'])).toBeInTheDocument()
    expect(screen.queryByText(other['don.subtitle'])).toBeNull()
  })
  it('SP-145 Billing', async () => {
    mount(<Billing />, locale)
    expect(await screen.findByRole('heading', { name: d['bill.title'] })).toBeInTheDocument()
    // SP-186 S4: in the open beta the subtitle is beta copy (config/pricing.js).
    const sub = PRICING_VISIBLE ? d['bill.subtitle'] : betaBillingSubtitle(locale)
    const otherSub = PRICING_VISIBLE ? other['bill.subtitle'] : betaBillingSubtitle(locale === 'es' ? 'en' : 'es')
    expect(screen.getByText(sub)).toBeInTheDocument()
    expect(screen.queryByText(otherSub)).toBeNull()
  })
  it('SP-144 Settings', async () => {
    mount(<OrgSettings />, locale)
    expect(await screen.findByText(d['orgs.ai.title'])).toBeInTheDocument()
    expect(screen.getByText(d['orgs.lang.title'])).toBeInTheDocument()
    expect(screen.queryByText(other['orgs.ai.title'])).toBeNull()
  })
  it('SP-128 Events search and table headers', async () => {
    mount(<Events />, locale)
    expect(await screen.findByPlaceholderText(d['ev.searchPh'])).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(other['ev.searchPh'])).toBeNull()
  })
  it('SP-138 Register sacrament filter', async () => {
    mount(<SacramentalRegister />, locale)
    expect(await screen.findByLabelText(d['reg.filterSac'])).toBeInTheDocument()
  })
  it('SP-147 Help panel module names and tips', () => {
    if (locale === 'es') localStorage.setItem('ochr_locale', 'es')
    render(<LocaleProvider><HelpPanel open onClose={() => {}} /></LocaleProvider>)
    expect(screen.getByRole('button', { name: d['nav.Intentions'] })).toBeInTheDocument()
    expect(screen.getByText(`✦ ${d['help.tip.0']}`)).toBeInTheDocument()
    expect(screen.queryByText(`✦ ${other['help.tip.0']}`)).toBeNull()
  })
})

describe('display-time mapping leaves stored tokens alone', () => {
  it('donation categories and methods', () => {
    expect(catLabel(esT, 'tithe')).toBe('diezmo')
    expect(methodLabel(esT, 'cash')).toBe('efectivo')
    expect(catLabel(esT, 'Some custom fund')).toBe('Some custom fund')
    expect(catLabel(enT, 'tithe')).toBe('tithe')
  })
  it('cash count label is English by default and Spanish when asked', () => {
    const SINGLE = { status: 'confirmed', counter_name: 'A', verifier_name: null }
    expect(cashCountVerificationLabel(SINGLE)).toBe(cashCountVerificationLabel(SINGLE, enT))
    expect(cashCountVerificationLabel(SINGLE, esT)).not.toBe(cashCountVerificationLabel(SINGLE))
  })
  it('billing plan copy from the server', () => {
    expect(planText(esT, 'Parish')).toBe(es['bill.plan.parish'])
    expect(planText(esT, 'Pro')).toBe('Pro')
  })
  it('SP-137 dashboard task categories and sample banner', () => {
    expect(taskCategoryLabel(esT, 'OUTREACH')).toBe('Pastoral social')
    expect(taskCategoryLabel(esT, 'CUSTOM')).toBe('CUSTOM')
    expect(sampleParts(esT, { members: 2 })).not.toEqual(sampleParts(enT, { members: 2 }))
  })
  it('help helpers fall back to English for unknown names and edited tips', () => {
    expect(moduleName(esT, 'Not A Module')).toBe('Not A Module')
    expect(localizedByIndex(esT, 'help.tip', 0, TIPS[0])).toBe(es['help.tip.0'])
    expect(localizedByIndex(esT, 'help.tip', 0, 'edited English tip')).toBe('edited English tip')
  })
})
