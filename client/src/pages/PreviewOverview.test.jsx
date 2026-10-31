// Stage 11 protected preview: copy guard + gate guard.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import PreviewOverview, { PREVIEW_COPY } from './PreviewOverview'

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: null, token: null, loading: false }) }))

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, 'PreviewOverview.jsx'), 'utf8')
const app = readFileSync(join(here, '..', 'App.jsx'), 'utf8')
const vercel = JSON.parse(readFileSync(join(here, '..', '..', '..', 'vercel.json'), 'utf8'))

function mount() {
  return render(<LocaleProvider><PreviewOverview /></LocaleProvider>)
}

describe('PreviewOverview', () => {
  it('shows a disabled call to action and a draft banner', () => {
    mount()
    expect(screen.getByRole('button', { name: PREVIEW_COPY.en.cta })).toBeDisabled()
    expect(screen.getByRole('note').textContent).toMatch(/not published/i)
  })

  it('sets robots noindex while mounted', () => {
    const { unmount } = mount()
    expect(document.head.querySelector('meta[name="robots"]')?.content).toMatch(/noindex/)
    unmount()
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull()
  })

  it('EN and ES carry the same keys, and the skip link is localized', () => {
    expect(Object.keys(PREVIEW_COPY.es).sort()).toEqual(Object.keys(PREVIEW_COPY.en).sort())
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Español' }))
    expect(screen.getByText(PREVIEW_COPY.es.skip)).toBeInTheDocument()
  })

  it('switches to Spanish with the same claim ids', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Español' }))
    expect(screen.getByText(PREVIEW_COPY.es.capsHeading)).toBeInTheDocument()
    expect(PREVIEW_COPY.es.caps.map(c => c[0])).toEqual(PREVIEW_COPY.en.caps.map(c => c[0]))
  })

  it('shows no price, no external URL and no tracking', () => {
    const all = JSON.stringify(PREVIEW_COPY)
    expect(all).not.toMatch(/\$\s?\d|€|USD|\/mo\b|per month|al mes/i)
    expect(src).not.toMatch(/https?:\/\//)
    expect(src).not.toMatch(/gtag|analytics|posthog|segment|mixpanel|plausible|fetch\(/i)
  })

  it('carries exactly the bounded claim ids C1-C4 and C6 (C5 deferred until #334)', () => {
    expect(PREVIEW_COPY.en.caps.map(c => c[0])).toEqual(['C1', 'C2', 'C3', 'C4', 'C6'])
  })

  it('route is registered only behind VITE_OC_PREVIEW and /preview is noindex at the edge', () => {
    expect(app).toMatch(/import\.meta\.env\.VITE_OC_PREVIEW === '1'/)
    const h = vercel.headers.find(x => x.source === '/preview/(.*)')
    expect(h?.headers).toContainEqual({ key: 'X-Robots-Tag', value: 'noindex, nofollow' })
  })
})
