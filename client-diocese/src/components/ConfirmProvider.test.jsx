// ConfirmProvider default title / Confirm / Save / Cancel go through
// the thin local strings map + t(). Hard-coded English is the remaining
// confirm chrome after parish #107. Restoring those literals in the
// fallbacks goes red. Caller-supplied labels still win.
//
// Diocese has no LocaleProvider. Device override (ochr_locale) is the
// only locale term — do not mount parish LocaleProvider here.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { STRINGS } from '../i18n/strings'
import { ConfirmProvider, useConfirm, usePrompt } from './ConfirmProvider'

const SRC_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ConfirmProvider.jsx')
const HARD_EN = ['Are you sure?', 'Confirm', 'Save', 'Cancel']

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function Ask({ opts } = {}) {
  const ask = useConfirm()
  return (
    <button type="button" onClick={() => { void ask(opts) }}>
      open-confirm
    </button>
  )
}

function PromptAsk({ opts } = {}) {
  const askFor = usePrompt()
  return (
    <button type="button" onClick={() => { void askFor(opts) }}>
      open-prompt
    </button>
  )
}

function view(child) {
  return render(
    <ConfirmProvider>
      {child}
    </ConfirmProvider>,
  )
}

async function openConfirm(opts) {
  view(<Ask opts={opts} />)
  await act(async () => {
    screen.getByRole('button', { name: 'open-confirm' }).click()
  })
}

async function openPrompt(opts) {
  view(<PromptAsk opts={opts} />)
  await act(async () => {
    screen.getByRole('button', { name: 'open-prompt' }).click()
  })
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('ConfirmProvider defaults are translated (thin local en+es)', () => {
  it('ENGLISH DEFAULTS USE t() COPY', async () => {
    await openConfirm()
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleName(STRINGS.en['confirm.title'])
    expect(screen.getByRole('heading', { name: STRINGS.en['confirm.title'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['confirm.confirm'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['confirm.cancel'] })).toBeInTheDocument()
  })

  it('SPANISH DEFAULTS ARE SPANISH — NOT THE ENGLISH CHROME', async () => {
    localStorage.setItem('ochr_locale', 'es')
    await openConfirm()
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName(STRINGS.es['confirm.title'])
    expect(screen.getByRole('heading', { name: STRINGS.es['confirm.title'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['confirm.confirm'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['confirm.cancel'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['confirm.title'] })).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.en['confirm.confirm'] })).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.en['confirm.cancel'] })).toBeNull()
    expect(screen.queryByText('Are you sure?')).toBeNull()
  })

  it('ENGLISH PROMPT DEFAULT CONFIRM LABEL IS SAVE', async () => {
    await openPrompt()
    expect(screen.getByRole('heading', { name: STRINGS.en['confirm.title'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['confirm.save'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['confirm.cancel'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['confirm.confirm'] })).toBeNull()
  })

  it('SPANISH PROMPT DEFAULT CONFIRM LABEL IS GUARDAR', async () => {
    localStorage.setItem('ochr_locale', 'es')
    await openPrompt()
    expect(screen.getByRole('heading', { name: STRINGS.es['confirm.title'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['confirm.save'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['confirm.cancel'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['confirm.save'] })).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.en['confirm.confirm'] })).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.en['confirm.cancel'] })).toBeNull()
  })

  it('CALLER-SUPPLIED LABELS STILL WIN UNDER es', async () => {
    localStorage.setItem('ochr_locale', 'es')
    await openConfirm({
      title: 'Close this year?',
      body: 'Published totals stay.',
      confirmLabel: 'Close year',
      cancelLabel: 'Keep open',
    })
    expect(screen.getByRole('heading', { name: 'Close this year?' })).toBeInTheDocument()
    expect(screen.getByText('Published totals stay.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close year' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep open' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.es['confirm.title'] })).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.es['confirm.confirm'] })).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.es['confirm.cancel'] })).toBeNull()
    expect(screen.queryByText(STRINGS.en['confirm.title'])).toBeNull()
  })

  it('string-form ask sets the body and still uses the locale title', async () => {
    localStorage.setItem('ochr_locale', 'es')
    await openConfirm('Remove this parish?')
    expect(screen.getByRole('heading', { name: STRINGS.es['confirm.title'] })).toBeInTheDocument()
    expect(screen.getByText('Remove this parish?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['confirm.confirm'] })).toBeInTheDocument()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN defaults', () => {
    const src = readFileSync(SRC_PATH, 'utf8')
    const jsx = stripComments(src)
    expect(src).toMatch(/t\('confirm\.title'\)/)
    expect(src).toMatch(/t\('confirm\.confirm'\)/)
    expect(src).toMatch(/t\('confirm\.save'\)/)
    expect(src).toMatch(/t\('confirm\.cancel'\)/)
    expect(jsx).not.toMatch(/useLocale\s*\(/)
    expect(jsx).not.toMatch(/LocaleProvider/)
    expect(jsx).not.toMatch(/from\s+['"][^'"]*\/i18n['"]/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code default ${JSON.stringify(phrase)}`).not.toMatch(
        new RegExp(`['"\`]${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`),
      )
    }
    expect(STRINGS.en['confirm.title']).toBe('Are you sure?')
    expect(STRINGS.en['confirm.confirm']).toBe('Confirm')
    expect(STRINGS.en['confirm.save']).toBe('Save')
    expect(STRINGS.en['confirm.cancel']).toBe('Cancel')
    expect(STRINGS.es['confirm.title']).toMatch(/est[aá] seguro/i)
    expect(STRINGS.es['confirm.confirm']).toMatch(/^confirmar$/i)
    expect(STRINGS.es['confirm.save']).toMatch(/^guardar$/i)
    expect(STRINGS.es['confirm.cancel']).toMatch(/^cancelar$/i)
    expect(STRINGS.es['confirm.title']).not.toBe(STRINGS.en['confirm.title'])
    expect(STRINGS.es['confirm.confirm']).not.toBe(STRINGS.en['confirm.confirm'])
    expect(STRINGS.es['confirm.save']).not.toBe(STRINGS.en['confirm.save'])
    expect(STRINGS.es['confirm.cancel']).not.toBe(STRINGS.en['confirm.cancel'])
  })

  it('ConfirmProvider mounts without a LocaleProvider', () => {
    expect(() => render(<ConfirmProvider><span>child</span></ConfirmProvider>))
      .not.toThrow()
    expect(screen.getByText('child')).toBeInTheDocument()
  })
})
