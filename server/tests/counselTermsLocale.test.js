// Beacon B-H5 — ES agreement placeholders must not keep the English
// "[COUNSEL TO SUPPLY]" marker. Labels are not counsel-supplied legal text.
import { describe, it, expect } from 'vitest'
import {
  COUNSEL_PLACEHOLDER,
  COUNSEL_PLACEHOLDERS,
  counselText,
  hasCounselPlaceholder,
} from '../src/lib/catering/counselTerms.js'

describe('Beacon B-H5: localized counsel placeholders', () => {
  it('uses English and Spanish markers for null terms', () => {
    expect(counselText('en', 'cancellation')).toBe(`${COUNSEL_PLACEHOLDERS.en} cancellation`)
    expect(counselText('es', 'cancellation')).toBe(`${COUNSEL_PLACEHOLDERS.es} cancelación`)
    expect(counselText('es', 'cancellation')).not.toContain(COUNSEL_PLACEHOLDER)
    expect(COUNSEL_PLACEHOLDERS.es).toMatch(/ASESORÍA LEGAL POR ENTREGAR/)
  })

  it('gates on either locale marker', () => {
    expect(hasCounselPlaceholder(counselText('en', 'refund'))).toBe(true)
    expect(hasCounselPlaceholder(counselText('es', 'refund'))).toBe(true)
    expect(hasCounselPlaceholder('Supplied wording only.')).toBe(false)
  })
})
