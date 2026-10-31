// Maintenance 2026-10-27: Finance Help must match #432 (OC-BOOKS-1 S0/S1).
// Import is a balanced trial-balance file (routes/finance.js /ledger/import),
// unmapped gifts after cutover block submission (409 unmapped_unknown), and
// mapping edits are effective-dated with refusals (finance/mappingWrite.js).
// There is no diocesan mapping write route yet.
import { describe, it, expect } from 'vitest'
import { MODULE_HELP as HELP } from './helpContent.js'

const f = HELP.finance
const all = [f.overview, ...f.features, ...f.tips].join('\n')

describe('Finance help after OC-BOOKS-1 S0/S1 (2026-10-27)', () => {
  it('describes import as a balanced trial-balance file, not batches', () => {
    expect(f.features).not.toContain('Ledger entries: manual or CSV import in batches')
    expect(all).toMatch(/trial-balance CSV for one period-end date that must balance and is saved all or nothing/)
  })
  it('says a period with unmapped gifts cannot be sent until they are mapped', () => {
    expect(all).toMatch(/has no account mapping has no account/)
    expect(all).toMatch(/can\u2019t be sent to the diocese until they are mapped/)
  })
  it('says mapping changes start today or later and cannot move a sent period', () => {
    expect(all).toMatch(/starts today or later/)
    expect(all).toMatch(/earlier gifts keep the account they had/)
    expect(all).toMatch(/period already sent to the diocese is refused/)
  })
  it('does not imply the diocese has a screen to set base-lowering mappings', () => {
    expect(all).toMatch(/is the diocese\u2019s to set/)
    expect(all).toMatch(/no screen yet for the diocese to set it/)
  })
})
