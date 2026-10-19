// Server AI refusals are mapped by code to our own EN/ES copy (TARS #280).
import { describe, it, expect } from 'vitest'
import { aiRefusalMessage } from './aiRefusal.js'
import { STRINGS } from '../i18n/strings.js'

const CODES = ['ai_disabled', 'ai_forbidden', 'ai_unsupported_provider', 'ai_input_too_large', 'ai_unavailable', 'org_type_forbidden', 'ai_failed']
const KEYS = [...CODES.map(c => `ai.refusal.${c}`), 'aist.historyAdminOnly', 'aist.historyFailed', 'lib.adminOnlyTitle', 'lib.adminOnlyBody', 'aist.readOnly']

describe('aiRefusalMessage', () => {
  const t = k => `T:${k}`
  it('maps every known refusal code to its own key, and never echoes server text', () => {
    for (const code of CODES) expect(aiRefusalMessage(t, { code, error: 'SERVER TEXT' }, 'fb')).toBe(`T:ai.refusal.${code}`)
  })
  it('falls back for an unknown code or no body', () => {
    expect(aiRefusalMessage(t, { code: 'nope', error: 'SERVER TEXT' }, 'fb')).toBe('T:fb')
    expect(aiRefusalMessage(t, undefined, 'fb')).toBe('T:fb')
  })
  it('every refusal / admin-only key exists, non-empty, in EN and ES, and ES is translated', () => {
    for (const k of KEYS) {
      expect(STRINGS.en[k], `en ${k}`).toBeTruthy()
      expect(STRINGS.es[k], `es ${k}`).toBeTruthy()
      expect(STRINGS.es[k], `es ${k}`).not.toBe(STRINGS.en[k])
    }
    expect(STRINGS.en['aist.readOnly']).not.toMatch(/history/i)
  })
})
