// Stage 6 — the chancery sign-in explains closed, held and turned-off
// logins in the office's language instead of the English server sentence.
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Login } from './App'
import { STRINGS } from './i18n/strings'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

describe('chancery sign-in refusals', () => {
  for (const locale of ['en', 'es']) {
    it.each([
      ['This login is deactivated. An admin can turn it back on.', 'auth.loginOff'],
      ['This login is closed. It cannot be turned back on.', 'auth.loginClosed'],
      ['This organization is on hold. Access is stopped; parish history remains.', 'auth.organizationHeld'],
    ])(`${locale}: %s`, async (serverSentence, key) => {
      localStorage.setItem('ochr_locale', locale)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: serverSentence }) }))
      const { container } = render(<Login onLogin={() => {}} onWantSignup={() => {}} />)
      fireEvent.change(container.querySelector('input[type=email]'), { target: { value: 'person@example.invalid' } })
      fireEvent.change(container.querySelector('input[type=password]'), { target: { value: 'a-password' } })
      fireEvent.submit(container.querySelector('form'))
      expect(await screen.findByText(STRINGS[locale][key])).toBeInTheDocument()
      if (locale === 'es') expect(container.textContent).not.toContain(serverSentence)
    })
  }
})
