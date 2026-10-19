// PR6: the audit-log CSV cell moved to utils/csv.js. Behaviour must be
// byte-identical to the former local auditLog.js csvCell (reference copy
// below, verbatim from main 57ffcb92).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { csvCell, guardFormula } from '../src/utils/csv.js'

function legacyCsvCell(v) {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}
const CASES = [null, undefined, '', 'plain', 'a "quoted" b', '=cmd|\'/c calc\'!A1', '+1', '-12.50', -12.5, '@SUM(A1)',
  '\tTab', '\rCR', 'multi\nline', 0, 42, true, 'Señora Ñ', ' =lead space', "'already"]

describe('shared csvCell', () => {
  it.each(CASES.map(c => [JSON.stringify(c), c]))('matches the former auditLog csvCell for %s', (_l, v) => {
    expect(csvCell(v)).toBe(legacyCsvCell(v))
  })
  it('auditLog.js uses the shared helper and no longer defines its own', () => {
    const src = readFileSync(new URL('../src/routes/auditLog.js', import.meta.url), 'utf8')
    expect(src).toMatch(/import \{ csvCell \} from '\.\.\/utils\/csv\.js'/)
    expect(src).not.toMatch(/function csvCell\(/)
  })
  it('report mode keeps plain numbers as numbers but guards formula text', () => {
    expect(guardFormula(-12.5, { allowNumbers: true })).toBe('-12.5')
    expect(guardFormula('-12.50', { allowNumbers: true })).toBe('-12.50')
    expect(guardFormula('-1+1', { allowNumbers: true })).toBe("'-1+1")
    expect(guardFormula('=1+1', { allowNumbers: true })).toBe("'=1+1")
  })
})
