import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBundledShellOrigin, sessionCookieCanRide } from './sessionOrigin'
import { STRINGS } from '../i18n/strings'

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sessionOrigin.js'), 'utf8')

describe('session cookie can ride only on the parish origin', () => {
  it('rides when the page and /api are the same origin', () => {
    expect(sessionCookieCanRide({
      documentUrl: 'http://127.0.0.1:5202/schedule',
      apiBase: '',
    })).toEqual({ ok: true, reason: 'same-origin-relative' })

    expect(sessionCookieCanRide({
      documentUrl: 'https://review.example/events',
      apiBase: 'https://review.example',
    })).toEqual({ ok: true, reason: 'same-origin-absolute' })
  })

  it('does not ride from the bundled shell or across origins', () => {
    expect(isBundledShellOrigin('capacitor://localhost/')).toBe(true)
    expect(isBundledShellOrigin('https://localhost/')).toBe(true)
    expect(isBundledShellOrigin('http://localhost:5202/')).toBe(false)

    expect(sessionCookieCanRide({
      documentUrl: 'capacitor://localhost/',
      apiBase: '',
    })).toEqual({ ok: false, reason: 'bundled-shell' })

    expect(sessionCookieCanRide({
      documentUrl: 'capacitor://localhost/login',
      apiBase: 'https://review.example',
    })).toEqual({ ok: false, reason: 'bundled-shell' })

    expect(sessionCookieCanRide({
      documentUrl: 'https://app.example/',
      apiBase: 'https://api.example',
    })).toEqual({ ok: false, reason: 'cross-origin' })
  })

  it('does not treat an unreadable address as able to keep the sign-in', () => {
    expect(sessionCookieCanRide({ documentUrl: '', apiBase: '' }).ok).toBe(false)
    expect(sessionCookieCanRide({ documentUrl: 'not a url', apiBase: '' }).reason).toBe('unreadable-document')
    expect(sessionCookieCanRide({
      documentUrl: 'https://review.example/',
      apiBase: 'notaurl',
    }).reason).toBe('unreadable-api')
  })

  it('does not read or store a token', () => {
    expect(SRC).not.toMatch(/localStorage|ochr_token|Authorization|Bearer/)
  })
})

describe('iOS shell copy stays inside what the screen knows', () => {
  const keys = [
    'ios.shell.signInTitle',
    'ios.shell.signInBody',
    'ios.shell.pushTitle',
    'ios.shell.pushBody',
    'ios.shell.pushAsk',
    'ios.shell.pushAsking',
    'ios.shell.pushGranted',
    'ios.shell.pushDenied',
    'ios.shell.pushDeclined',
    'ios.shell.pushNotRegistered',
    'ios.shell.pushUnavailable',
  ]

  it('has a distinct Spanish sentence for each line', () => {
    for (const key of keys) {
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key]).not.toBe(STRINGS.en[key])
    }
  })

  it('does not claim records were lost, a cache hit, or that a notice was sent', () => {
    for (const key of keys) {
      for (const locale of ['en', 'es']) {
        const line = STRINGS[locale][key].toLowerCase()
        expect(line).not.toMatch(/nothing was lost|nada se perdió|cached|caché|notice was sent|aviso fue enviado/)
      }
    }
  })
})
