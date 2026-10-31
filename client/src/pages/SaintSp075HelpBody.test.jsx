// Saint re-probe (d06909ab, minor): the Intentions Help body, not only
// the tip/FAQ, explains the unassigned case using the on-sheet wording.
import { describe, it, expect } from 'vitest'
import { MODULE_HELP } from '../data/helpContent'
import { STRINGS } from '../i18n/strings'

describe('Intentions help body: unassigned intentions', () => {
  it('a feature line explains that unassigned intentions still print, with the sheet marker', () => {
    const line = MODULE_HELP.intentions.features.find(f => f.startsWith('Weekly sheet'))
    expect(line).toContain('still prints')
    expect(line).toContain(STRINGS.en['sheet.unassigned'])
  })
})
