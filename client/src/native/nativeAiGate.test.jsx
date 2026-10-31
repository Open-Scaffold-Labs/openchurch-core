// Native AI build gate. Each inventoried client surface is unreachable in
// excluded mode. A gate that renders the surface anyway fails that test.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useRef, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ThemeProvider } from '../context/ThemeContext'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { ProtectedLayout, Sidebar, visibleNavFor } from '../App'
import useDialogFocus from '../components/useDialogFocus'
import AssistantWidget from '../components/AssistantWidget'
import AITextArea from '../components/AITextArea'
import HelpPanel from '../components/HelpPanel'
import Welcome from '../pages/Welcome'
import OrgSettings from '../pages/OrgSettings'
import Support from '../pages/Support'
import NativeAiConsentCard from './NativeAiConsentCard'
import { AiSurfaceGate, AiConsentScreen } from './AiConsentScreen'
import { NativeAiProvider, NativeAiState, classifyNativeAccess, useNativeAi } from './NativeAiContext'
import { NATIVE_AI_DISCLOSURE, NATIVE_AI_DISCLOSURE_VERSION } from './nativeAiDisclosure'
import {
  NATIVE_AI_ARCHIVE_TOKEN,
  NATIVE_SHELL_UA,
  applyArchiveAiCeiling,
  ceilingFromUserAgent,
  intersectNativeAiMode,
  nativeAiBuildCeiling,
} from './nativeAiCeiling'
import { AI_INVENTORY } from './aiInventory'
import { filterAiCommands, isAiPath } from './aiGate'
import { pageCommandsForQuery } from '../components/GlobalSearchPalette'
import { planPurchaseOfferedInShell } from './planPurchase'
import { isRuntimeApiCacheable } from '../swPolicy'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(HERE, rel), 'utf8')
const ORIGINAL_UA = navigator.userAgent

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Ada Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', timezone: 'UTC' } },
    updateUser: vi.fn(),
    token: 't',
    loading: false,
    isAuthenticated: true,
    canWrite: true,
  }),
}))

const ORG = {
  id: 1, name: 'St Test', slug: 'st-test', address: '', tax_id: '',
  signatory_name: '', signatory_title: '', statement_letterhead: '',
  tagline: '', about: '', service_times: '', page_published: false,
  reminder_lead_hours: 24, timezone: 'America/Los_Angeles', locale: 'en',
}

function shell(ui) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>{ui}</ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </ThemeProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  localStorage.clear()
  delete window.Capacitor
  Object.defineProperty(navigator, 'userAgent', { value: ORIGINAL_UA, configurable: true })
  vi.stubGlobal('matchMedia', (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
})

describe('native AI inventory', () => {
  it('names every client surface in this file', () => {
    const src = read('nativeAiGate.test.jsx')
    for (const row of AI_INVENTORY.filter(r => r.suite === 'client')) {
      expect(src, row.id).toContain(row.id)
    }
  })
})

describe('nav-ai-studio and nav-library', () => {
  it('hides AI Studio and Library for an admin when AI is excluded, and shows them on the web', async () => {
    expect(visibleNavFor('admin', false, 'excluded').some(i => i.to === '/ai' || i.to === '/library')).toBe(false)
    expect(visibleNavFor('admin', false, 'web').some(i => i.to === '/ai')).toBe(true)
    expect(visibleNavFor('admin', false, 'web').some(i => i.to === '/library')).toBe(true)

    const { unmount } = shell(
      <NativeAiState kind="excluded">
        <Sidebar />
      </NativeAiState>,
    )
    expect(screen.queryByRole('link', { name: 'AI Studio' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Library' })).toBeNull()
    unmount()

    shell(
      <NativeAiState kind="web">
        <Sidebar />
      </NativeAiState>,
    )
    expect(await screen.findByRole('link', { name: 'AI Studio' })).toHaveAttribute('href', '/ai')
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('href', '/library')
  })
})

describe('route-ai-studio, route-library, and ai-studio-no-key', () => {
  it('does not mount AI Studio, its no-key state, or the Library when excluded or awaiting agreement', () => {
    const app = read('../App.jsx')
    expect(app).toMatch(/path="\/ai"[\s\S]{0,180}AiSurfaceGate/)
    expect(app).toMatch(/path="\/library"[\s\S]{0,180}AiSurfaceGate/)
    function Probe() {
      return <p>{STRINGS.en['aist.noKey']}</p>
    }
    const { unmount } = shell(
      <NativeAiState kind="excluded"><AiSurfaceGate><Probe /></AiSurfaceGate></NativeAiState>,
    )
    expect(screen.queryByText(STRINGS.en['aist.noKey'])).toBeNull()
    expect(screen.getByTestId('ai-closed')).toBeInTheDocument()
    unmount()

    shell(
      <NativeAiState kind="consent"><AiSurfaceGate><Probe /></AiSurfaceGate></NativeAiState>,
    )
    expect(screen.queryByText(STRINGS.en['aist.noKey'])).toBeNull()
    expect(screen.getByTestId('ai-consent')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText(/Anthropic or OpenAI/)).toBeInTheDocument()
  })

  it('mounts the page on the web', () => {
    shell(
      <NativeAiState kind="web"><AiSurfaceGate><p>studio-mounted</p></AiSurfaceGate></NativeAiState>,
    )
    expect(screen.getByText('studio-mounted')).toBeInTheDocument()
  })
})

describe('quota-meter', () => {
  it('is only imported by AI Studio, which the excluded gate does not mount', () => {
    const root = join(HERE, '..')
    const hits = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          if (name === 'node_modules') continue
          walk(full)
        } else if (/\.(js|jsx)$/.test(name) && !name.includes('.test.')) {
          // A production import, not a mention in the inventory or a comment.
          if (/import\s+AiQuotaMeter\b/.test(readFileSync(full, 'utf8'))) {
            hits.push(full.slice(root.length + 1))
          }
        }
      }
    }
    walk(root)
    expect(hits.sort()).toEqual(['pages/AI.jsx'])
  })
})

describe('assistant-quill, assistant-shortcut, and assistant-send', () => {
  it('renders no launcher and does not send when excluded', () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ available: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    shell(<NativeAiState kind="excluded"><AssistantWidget /></NativeAiState>)
    expect(screen.queryByRole('button', { name: STRINGS.en['ast.open'] })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: '/', ctrlKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the agreement screen and does not send before consent', () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ available: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    shell(<NativeAiState kind="consent"><AssistantWidget /></NativeAiState>)
    fireEvent.click(screen.getByTestId('assistant-consent-launcher'))
    expect(screen.getByTestId('ai-consent')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('ai-consent-decline'))
    expect(screen.queryByTestId('ai-consent')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('command-palette', () => {
  it('drops AI paths in excluded mode and the palette calls that filter', () => {
    expect(filterAiCommands([{ to: '/ai' }, { to: '/library' }, { to: '/packet' }], 'excluded').map(c => c.to)).toEqual(['/packet'])
    expect(filterAiCommands([{ to: '/ai' }], 'web').map(c => c.to)).toEqual(['/ai'])
    for (const q of ['ai', 'studio', 'assistant', 'library', 'feather', 'estudio']) {
      const hits = filterAiCommands(pageCommandsForQuery(q, 'admin'), 'excluded')
      expect(hits.some(h => isAiPath(h.to))).toBe(false)
    }
    expect(read('../components/GlobalSearchPalette.jsx')).toContain('filterAiCommands(')
  })
})

describe('help-ai-studio, help-library, help-assistant-faq, and help-role-assistant', () => {
  it('removes the AI guide, the assistant question, and the assistant role wording when excluded', () => {
    const { unmount } = shell(
      <NativeAiState kind="excluded"><HelpPanel open onClose={() => {}} /></NativeAiState>,
    )
    expect(screen.queryByRole('button', { name: 'AI Studio' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Library' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['help.tabFaq'] }))
    expect(screen.queryByText('Does the AI assistant answer canon-law questions?')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['help.tabRoles'] }))
    expect(screen.queryByText('Report a problem; use the Assistant')).toBeNull()
    expect(screen.getByText(STRINGS.en['help.roleReportOnly'])).toBeInTheDocument()
    unmount()

    shell(<NativeAiState kind="web"><HelpPanel open onClose={() => {}} /></NativeAiState>)
    expect(screen.getByRole('button', { name: 'AI Studio' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Library' })).toBeInTheDocument()
  })
})

describe('member-notes-enhance', () => {
  it('has no Improve control and does not send when excluded', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    shell(
      <NativeAiState kind="excluded">
        <AITextArea value="A note about Sunday" onChange={() => {}} placeholder="Notes" />
      </NativeAiState>,
    )
    expect(screen.queryByTestId('ai-enhance')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('opens the agreement screen instead of posting when consent is required', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    shell(
      <NativeAiState kind="consent">
        <AITextArea value="A note about Sunday" onChange={() => {}} placeholder="Notes" />
      </NativeAiState>,
    )
    fireEvent.click(screen.getByTestId('ai-enhance'))
    expect(screen.getByTestId('ai-consent')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('welcome-studio', () => {
  it('hides the AI Studio card when excluded and keeps it on the web', () => {
    const { unmount } = shell(
      <NativeAiState kind="excluded"><Welcome /></NativeAiState>,
    )
    expect(screen.queryByRole('heading', { name: STRINGS.en['welcome.studio'] })).toBeNull()
    unmount()
    shell(<NativeAiState kind="web"><Welcome /></NativeAiState>)
    expect(screen.getByRole('heading', { name: STRINGS.en['welcome.studio'] })).toBeInTheDocument()
  })
})

describe('org-ai-key', () => {
  it('does not mount the parish key form when excluded, and does on the web', async () => {
    const urls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      urls.push(String(url))
      if (String(url).includes('/api/organization')) return { ok: true, json: async () => ORG }
      if (String(url).includes('/api/parish-feasts')) return { ok: true, json: async () => ({ feasts: [] }) }
      if (String(url).includes('/api/affiliation')) return { ok: true, json: async () => ({ affiliation: null }) }
      if (String(url).includes('/api/ai/provider')) return { ok: true, json: async () => ({ source: 'platform', provider: null, model: null, key_last4: null }) }
      return { ok: true, json: async () => ({}) }
    }))
    const { unmount } = shell(<NativeAiState kind="excluded"><OrgSettings /></NativeAiState>)
    expect(await screen.findByDisplayValue('St Test')).toBeInTheDocument()
    await new Promise(r => setTimeout(r, 30))
    expect(urls.some(u => u.includes('/api/ai/provider'))).toBe(false)
    unmount()

    urls.length = 0
    shell(<NativeAiState kind="web"><OrgSettings /></NativeAiState>)
    expect(await screen.findByDisplayValue('St Test')).toBeInTheDocument()
    await waitFor(() => expect(urls.some(u => u.includes('/api/ai/provider'))).toBe(true))
  })
})

describe('support-console-diagnosis', () => {
  const ticket = {
    id: 4, description: 'The lights failed on Sunday', severity: 'normal', status: 'new',
    created_at: '2026-03-01T15:04:00.000Z',
  }
  function stub() {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/support-tickets/4')) {
        return { ok: true, json: async () => ({ ...ticket, diagnosis: { narrative: 'NATIVE-AI-DIAGNOSIS', confidence: 'low' } }) }
      }
      return { ok: true, json: async () => ({ tickets: [ticket], vendor: false }) }
    }))
  }
  it('hides an AI diagnosis when excluded and shows it on the web', async () => {
    stub()
    const { unmount } = shell(<NativeAiState kind="excluded"><Support /></NativeAiState>)
    fireEvent.click(await screen.findByRole('button', { name: /The lights failed on Sunday/ }))
    expect(await screen.findByRole('combobox')).toBeInTheDocument()
    expect(screen.queryByText('NATIVE-AI-DIAGNOSIS')).toBeNull()
    unmount()

    stub()
    shell(<NativeAiState kind="web"><Support /></NativeAiState>)
    fireEvent.click(await screen.findByRole('button', { name: /The lights failed on Sunday/ }))
    expect(await screen.findByText('NATIVE-AI-DIAGNOSIS')).toBeInTheDocument()
  })
})

describe('preferences-withdraw and preferences-consent-screen', () => {
  it('shows the agreement time, withdraws from settings, and opens the dedicated screen', async () => {
    const withdraw = vi.fn(async () => ({ ok: true }))
    shell(
      <NativeAiState kind="open" consent={{ consented_at: '2026-03-01T15:04:00.000Z', withdrawn_at: null }} withdraw={withdraw}>
        <NativeAiConsentCard />
      </NativeAiState>,
    )
    expect(screen.getByText(/2026/)).toBeInTheDocument()
    expect(screen.queryByText(/Invalid Date/)).toBeNull()
    expect(screen.queryByText('ai.prefs.active')).toBeNull()
    fireEvent.click(screen.getByTestId('native-ai-withdraw'))
    expect(withdraw).toHaveBeenCalled()

    shell(
      <NativeAiState kind="consent" consent={null}>
        <NativeAiConsentCard />
      </NativeAiState>,
    )
    fireEvent.click(screen.getByTestId('native-ai-review'))
    expect(screen.getByTestId('ai-consent')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('renders nothing on the web and when AI is excluded', () => {
    const { unmount } = shell(<NativeAiState kind="web"><NativeAiConsentCard /></NativeAiState>)
    expect(screen.queryByText(STRINGS.en['ai.prefs.title'])).toBeNull()
    unmount()
    shell(<NativeAiState kind="excluded"><NativeAiConsentCard /></NativeAiState>)
    expect(screen.queryByText(STRINGS.en['ai.prefs.title'])).toBeNull()
  })
})

describe('dedicated consent screen', () => {
  it('names the provider in Spanish and does not agree when the person declines', () => {
    localStorage.setItem('ochr_locale', 'es')
    const agree = vi.fn(async () => ({ ok: true }))
    shell(
      <NativeAiState kind="consent" agree={agree}>
        <AiConsentScreen />
      </NativeAiState>,
    )
    expect(screen.getByText(STRINGS.es['ai.consent.draft'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['ai.consent.draft'])).toBeNull()
    expect(screen.getAllByText(/Anthropic/).length).toBeGreaterThan(0)
    expect(screen.getByText(NATIVE_AI_DISCLOSURE.es.parish)).toBeInTheDocument()
    const panel = screen.getByTestId('ai-consent')
    expect(panel).not.toHaveAttribute('role', 'dialog')
    expect(panel).not.toHaveAttribute('aria-modal')
    fireEvent.click(screen.getByTestId('ai-consent-decline'))
    expect(agree).not.toHaveBeenCalled()
  })
})

describe('billing-plan-features', () => {
  it('does not offer plan purchase, including the AI feature list, in the native shell', () => {
    expect(planPurchaseOfferedInShell(true)).toBe(false)
    expect(planPurchaseOfferedInShell(false)).toBe(true)
    expect(read('../pages/Billing.jsx')).toContain('offerPurchase')
  })
})

describe('sw-ai-cache', () => {
  it('does not runtime-cache AI or assistant responses', () => {
    expect(isRuntimeApiCacheable('/api/ai/generations')).toBe(false)
    expect(isRuntimeApiCacheable('/api/ai/quota')).toBe(false)
    expect(isRuntimeApiCacheable('/api/ai/provider')).toBe(false)
    expect(isRuntimeApiCacheable('/api/assistant/status')).toBe(false)
    expect(isRuntimeApiCacheable('/api/assistant')).toBe(false)
    expect(isRuntimeApiCacheable('/api/clients')).toBe(true)
    expect(isRuntimeApiCacheable('/api/daily-verse')).toBe(true)
    const sw = read('../sw.js')
    expect(sw).toContain('isRuntimeApiCacheable(url.pathname)')
    expect(sw).not.toContain("url.pathname.startsWith('/api/')")
  })
})

describe('native access provider', () => {
  function Kind() {
    return null
  }
  it('classifies the server answer and fails closed', () => {
    expect(classifyNativeAccess(null)).toBe('unavailable')
    expect(classifyNativeAccess({ applies: false, mode: 'web' })).toBe('unavailable')
    expect(classifyNativeAccess({ applies: true, mode: 'excluded' })).toBe('excluded')
    const offered = {
      applies: true, mode: 'consent-required', required_disclosure_version: NATIVE_AI_DISCLOSURE_VERSION,
      consent_active: true,
      consent: { disclosure_version: NATIVE_AI_DISCLOSURE_VERSION, consented_at: '2026-03-01T15:04:00.000Z', withdrawn_at: null },
    }
    expect(classifyNativeAccess(offered)).toBe('excluded')
    expect(classifyNativeAccess(offered, { ceiling: 'excluded', renderedVersion: NATIVE_AI_DISCLOSURE_VERSION })).toBe('excluded')
    expect(classifyNativeAccess(
      { applies: true, mode: 'excluded', consent_active: false, consent: null },
      { ceiling: 'consent-required', renderedVersion: NATIVE_AI_DISCLOSURE_VERSION },
    )).toBe('excluded')
    expect(classifyNativeAccess(
      { ...offered, consent_active: false, consent: null },
      { ceiling: 'consent-required', renderedVersion: NATIVE_AI_DISCLOSURE_VERSION },
    )).toBe('consent')
    expect(classifyNativeAccess(offered, { ceiling: 'consent-required', renderedVersion: NATIVE_AI_DISCLOSURE_VERSION })).toBe('open')
    expect(classifyNativeAccess(
      { ...offered, required_disclosure_version: 'server-b', consent: { ...offered.consent, disclosure_version: 'server-b' } },
      { ceiling: 'consent-required', renderedVersion: NATIVE_AI_DISCLOSURE_VERSION },
    )).toBe('disclosure-stale')
    expect(Kind).toBeTypeOf('function')
  })

  it('does not ask the server on the web, and reads excluded on the native shell', async () => {
    const urls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      urls.push(String(url))
      return { ok: true, json: async () => ({ applies: true, mode: 'excluded', consent_active: false, consent: null }) }
    }))
    const { unmount } = shell(<NativeAiProvider><p>web</p></NativeAiProvider>)
    await new Promise(r => setTimeout(r, 20))
    expect(urls.some(u => u.includes('/api/ai/native-access'))).toBe(false)
    unmount()

    window.Capacitor = { isNativePlatform: () => true }
    shell(<NativeAiProvider><p>native</p></NativeAiProvider>)
    await waitFor(() => expect(urls.some(u => u.includes('/api/ai/native-access'))).toBe(true))
  })
})

function KindProbe() {
  const { kind } = useNativeAi()
  return <span data-testid="native-kind">{kind}</span>
}

describe('R388-1 build ceiling', () => {
  it('stays excluded when an excluded build is offered consent and an active agreement', async () => {
    expect(nativeAiBuildCeiling()).toBe('excluded')
    expect(intersectNativeAiMode('excluded', 'consent-required')).toBe('excluded')
    expect(intersectNativeAiMode('consent-required', 'excluded')).toBe('excluded')
    window.Capacitor = { isNativePlatform: () => true }
    const headers = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      headers.push(new Headers(init?.headers).get('x-oc-native-ai-ceiling'))
      return {
        ok: true,
        json: async () => ({
          applies: true,
          mode: 'consent-required',
          required_disclosure_version: NATIVE_AI_DISCLOSURE_VERSION,
          consent_active: true,
          consent: {
            disclosure_version: NATIVE_AI_DISCLOSURE_VERSION,
            consented_at: '2026-03-01T15:04:00.000Z',
            withdrawn_at: null,
          },
        }),
      }
    }))
    shell(<NativeAiProvider><KindProbe /></NativeAiProvider>)
    await waitFor(() => expect(screen.getByTestId('native-kind')).toHaveTextContent('excluded'))
    expect(headers).toContain('excluded')
  })

  it('keeps an excluded archive closed when the hosted bundle was built consent-required', async () => {
    vi.stubEnv('VITE_OC_NATIVE_AI_CEILING', 'consent-required')
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone) OpenChurchNative',
      configurable: true,
    })
    expect(nativeAiBuildCeiling()).toBe('excluded')
    window.Capacitor = { isNativePlatform: () => true }
    const headers = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      headers.push(new Headers(init?.headers).get('x-oc-native-ai-ceiling'))
      return {
        ok: true,
        json: async () => ({
          applies: true,
          mode: 'consent-required',
          required_disclosure_version: NATIVE_AI_DISCLOSURE_VERSION,
          consent_active: true,
          consent: {
            disclosure_version: NATIVE_AI_DISCLOSURE_VERSION,
            consented_at: '2026-03-01T15:04:00.000Z',
            withdrawn_at: null,
          },
        }),
      }
    }))
    shell(<NativeAiProvider><KindProbe /></NativeAiProvider>)
    await waitFor(() => expect(screen.getByTestId('native-kind')).toHaveTextContent('excluded'))
    expect(headers).toContain('excluded')
    expect(headers).not.toContain('consent-required')
  })

  it('writes the ceiling into the archive user agent, not the hosted bundle', () => {
    const archived = applyArchiveAiCeiling(
      { appendUserAgent: 'stale', server: { url: 'https://parish.example', errorPath: 'offline.html' } },
      { VITE_OC_NATIVE_AI_CEILING: 'consent-required', CAP_SERVER_URL: 'https://parish.example' },
    )
    expect(archived.appendUserAgent).toBe(NATIVE_SHELL_UA)
    expect(archived.server.url).toBe('https://parish.example')
    expect(ceilingFromUserAgent(`Mozilla/5.0 ${archived.appendUserAgent}`)).toBe('excluded')
    const hostedLater = 'consent-required'
    expect(ceilingFromUserAgent(`Mozilla/5.0 ${archived.appendUserAgent}`)).not.toBe(hostedLater)

    const capable = applyArchiveAiCeiling(archived, { OC_IOS_AI_CEILING: 'consent-required' })
    expect(capable.appendUserAgent).toBe(`${NATIVE_SHELL_UA} ${NATIVE_AI_ARCHIVE_TOKEN}`)
    expect(ceilingFromUserAgent(capable.appendUserAgent)).toBe('consent-required')
    expect(archived.appendUserAgent).toBe(NATIVE_SHELL_UA)

    const sync = read('../../scripts/ios-sync.mjs')
    const config = read('../../capacitor.config.json')
    expect(sync.indexOf('applyArchiveAiCeiling')).toBeGreaterThan(-1)
    expect(sync.indexOf('applyArchiveAiCeiling')).toBeLessThan(sync.indexOf("run(cap, ['sync', 'ios'])"))
    expect(config).toContain('"appendUserAgent": "OpenChurchNative"')
    expect(config).not.toContain(NATIVE_AI_ARCHIVE_TOKEN)
    expect(read('../../../server/src/ai/nativeAiMode.js')).toContain(NATIVE_AI_ARCHIVE_TOKEN)
  })

  it('fails closed when a consent-capable build hears that the host excludes AI', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: `Mozilla/5.0 ${NATIVE_SHELL_UA} ${NATIVE_AI_ARCHIVE_TOKEN}`,
      configurable: true,
    })
    expect(nativeAiBuildCeiling()).toBe('consent-required')
    window.Capacitor = { isNativePlatform: () => true }
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ applies: true, mode: 'excluded', consent_active: false, consent: null }),
    })))
    shell(<NativeAiProvider><KindProbe /></NativeAiProvider>)
    await waitFor(() => expect(screen.getByTestId('native-kind')).toHaveTextContent('excluded'))
  })
})

describe('R388-3 Improve consent dialog', () => {
  function Editor() {
    const ref = useRef(null)
    const [open, setOpen] = useState(true)
    useDialogFocus(ref, () => setOpen(false))
    if (!open) return <p>editor-closed</p>
    return (
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Edit member" tabIndex={-1}>
        <button type="button">Save member</button>
        <AITextArea value="a parish note" onChange={() => {}} />
      </div>
    )
  }

  it('closes after agreement without sending the note, and keeps the dialog on failure', async () => {
    const agree = vi.fn(async () => ({ ok: true }))
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ result: 'rewritten' }) }))
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = shell(
      <NativeAiState kind="consent" agree={agree}>
        <AITextArea value="a parish note" onChange={() => {}} />
      </NativeAiState>,
    )
    const opener = screen.getByTestId('ai-enhance')
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.click(screen.getByTestId('ai-consent-agree'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(agree).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(opener))
    unmount()

    const failed = vi.fn(async () => ({ ok: false }))
    shell(
      <NativeAiState kind="consent" agree={failed}>
        <AITextArea value="a parish note" onChange={() => {}} />
      </NativeAiState>,
    )
    fireEvent.click(screen.getByTestId('ai-enhance'))
    fireEvent.click(screen.getByTestId('ai-consent-agree'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(failed).toHaveBeenCalledTimes(1)
  })

  it('traps Tab, closes on Escape, and leaves an enclosing editor open', () => {
    const root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
    const agree = vi.fn(async () => ({ ok: true }))
    render(
      <MemoryRouter>
        <LocaleProvider>
          <ToastProvider>
            <NativeAiState kind="consent" agree={agree}>
              <Editor />
            </NativeAiState>
          </ToastProvider>
        </LocaleProvider>
      </MemoryRouter>,
      { container: root },
    )
    const opener = screen.getByTestId('ai-enhance')
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: NATIVE_AI_DISCLOSURE.en.title })
    expect(root.inert).toBe(true)
    const agreeBtn = screen.getByTestId('ai-consent-agree')
    const declineBtn = screen.getByTestId('ai-consent-decline')
    declineBtn.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(agreeBtn)
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(declineBtn)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('ai-consent')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Edit member' })).toBeInTheDocument()
    expect(agree).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(opener)
    expect(root.inert).toBe(false)
    root.remove()
  })

  it('returns focus only after #root is no longer inert', () => {
    const root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
    const original = HTMLElement.prototype.focus
    const attempts = []
    HTMLElement.prototype.focus = function inertAwareFocus(...args) {
      let node = this
      let blocked = false
      while (node) {
        if (node.nodeType === 1 && node.hasAttribute('inert')) {
          blocked = true
          break
        }
        node = node.parentElement
      }
      attempts.push({ id: this.getAttribute?.('data-testid') || '', blocked })
      if (blocked) return undefined
      return original.apply(this, args)
    }
    try {
      render(
        <MemoryRouter>
          <LocaleProvider>
            <ToastProvider>
              <NativeAiState kind="consent" agree={async () => ({ ok: true })}>
                <Editor />
              </NativeAiState>
            </ToastProvider>
          </LocaleProvider>
        </MemoryRouter>,
        { container: root },
      )
      const opener = screen.getByTestId('ai-enhance')
      opener.focus()
      fireEvent.click(opener)
      expect(root.hasAttribute('inert')).toBe(true)
      fireEvent.keyDown(window, { key: 'Escape' })
      const restore = attempts.filter(a => a.id === 'ai-enhance')
      expect(restore.at(-1)?.blocked).toBe(false)
      expect(document.activeElement).toBe(opener)
      expect(root.hasAttribute('inert')).toBe(false)
    } finally {
      HTMLElement.prototype.focus = original
      root.remove()
    }
  })
})

describe('R388-4 rendered developer comments', () => {
  it('does not show the print-shell notes in the signed-in app', () => {
    const { container } = shell(<ProtectedLayout />)
    expect(container.textContent).not.toContain('h-screen + overflow-auto would clip')
    expect(container.textContent).not.toContain("sidebar's padding would print")
    expect(container.textContent).not.toContain('in print the shell flattens')
  })
})
