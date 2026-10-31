// OC-WEB-1 PR-D — parish page publish screen.
// One h1, t() copy in en and es (usted), and a confirmed publish.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import SitePublish from './SitePublish'

const ask = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      role: 'admin',
      organization: { id: 1, locale: 'en', name: 'St Test' },
    },
  }),
}))

vi.mock('../components/ConfirmProvider', () => ({
  useConfirm: () => ask,
}))

const HERE = dirname(fileURLToPath(import.meta.url))

function siteBody(overrides = {}) {
  return {
    site: {
      draft: {
        version: 1,
        pages: [{
          id: 'home',
          title: { en: 'Home', es: 'Inicio' },
          blocks: [{ type: 'hero_split', headline: { en: 'Draft headline', es: 'Titular del borrador' } }],
        }],
        nav: [],
      },
      published: null,
      look_id: 'warm-editorial',
      revision: 4,
      published_at: null,
      has_published: false,
      draft_matches_published: false,
      can_revert: false,
      page_published: true,
      history: [],
      custom_domain: null,
      ...overrides,
    },
  }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <SitePublish />
      </LocaleProvider>
    </MemoryRouter>,
  )
}

describe('SitePublish', () => {
  beforeEach(() => {
    ask.mockReset()
    ask.mockResolvedValue(true)
    localStorage.removeItem('ochr_locale')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => siteBody(),
    })))
  })

  it('shows one heading, the draft preview, and publishes only after confirmation', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { level: 1, name: 'Parish page' })).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByText('Draft headline')).toBeTruthy()
    expect(screen.getByText('Visitors do not see this draft yet.')).toBeTruthy()

    const publish = screen.getByRole('button', { name: 'Publish' })
    expect(publish.className).toContain('min-h-[44px]')
    expect(publish.className).toContain('focus:ring-2')

    fireEvent.click(publish)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Publish this draft?',
      confirmLabel: 'Publish the page',
    }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const [, init] = fetch.mock.calls[1]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ confirm: true, expected_revision: 4 }))
    expect(String(fetch.mock.calls[1][0])).toContain('/api/organization/site/publish')
  })

  it('does not publish when the confirmation is declined', async () => {
    ask.mockResolvedValue(false)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(ask).toHaveBeenCalled())
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('tells the secretary to reload when someone else edited the page', async () => {
    fetch.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            code: 'site_revision_conflict',
            error: 'Someone else edited this page. Your change was not saved. Reload the page to see their version, then try again.',
          }),
        }
      }
      return { ok: true, status: 200, json: async () => siteBody() }
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Someone else edited this page/)
    expect(alert.textContent).toMatch(/Reload/)
    expect(screen.getByRole('button', { name: 'Reload the page' }).className).toContain('min-h-[44px]')
  })

  it('uses usted Spanish for the same screen', async () => {
    localStorage.setItem('ochr_locale', 'es')
    renderPage()
    expect(await screen.findByRole('heading', { level: 1, name: 'Página de la parroquia' })).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByText('Titular del borrador')).toBeTruthy()
    expect(screen.getByText('Los visitantes todavía no ven este borrador.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Publicar' })).toBeTruthy()
  })
})

describe('site.pub copy', () => {
  const keys = Object.keys(STRINGS.en).filter((key) => key.startsWith('site.pub.'))

  it('has the same keys in English and Spanish, in the usted form', () => {
    expect(keys.length).toBeGreaterThan(20)
    for (const key of keys) {
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
      expect(STRINGS.es[key], key).not.toMatch(/\b(publícalo|recárgala|inténtalo|agrégalo|enciéndela|puedes|tienes)\b/i)
    }
    expect(STRINGS.es['site.pub.conflict']).toMatch(/Recargue/)
    expect(STRINGS.es['site.pub.subtitle']).toMatch(/Publique/)
    expect(STRINGS.en['site.pub.conflict']).toMatch(/Someone else edited this page/)
    expect(STRINGS.en['site.pub.conflict']).toMatch(/Reload/)
    const settings = readFileSync(join(HERE, 'OrgSettings.jsx'), 'utf8')
    expect(settings).toMatch(/t\('site\.pub\.settingsLink'\)/)
    const page = readFileSync(join(HERE, 'SitePublish.jsx'), 'utf8')
    expect(page).not.toMatch(/<h1/)
  })
})
