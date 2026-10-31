// Maintenance 2026-10-28: Intentions and Finance Help must match #442
// (SP-250 Mass stipend liability, migration 136) and the deposit-adjustment
// holds. A recorded offering is a 2330 liability, not income, non-assessable
// (finance/stipends.js, 136-mass-stipend-liability.js); delete is refused once
// an offering, fulfilment or void exists (routes/massIntentions.js DELETE);
// void is admin-only with a reason and, while the offering is held, a
// disposition (POST /:id/void). Administrators use Void / disposition on the Intentions screen; Release stipend is not available yet. Submission is
// refused while dispositions are pending (stipend_dispositions_pending) or
// deposit adjustments are missing from the roll-up (deposit_adjustments_pending).
import { describe, it, expect } from 'vitest'
import { MODULE_HELP as HELP, FAQ } from './helpContent.js'

const mi = HELP.intentions
const miAll = [mi.overview, ...mi.features, ...mi.tips, ...mi.sections.map(s => s.content || '')].join('\n')
const f = HELP.finance
const fAll = [f.overview, ...f.features, ...f.tips].join('\n')

describe('Intentions and Finance help after SP-250 (2026-10-28)', () => {
  it('says a recorded offering is a 2330 liability, not income, not assessable', () => {
    expect(miAll).toMatch(/account 2330, Mass Stipends Payable\), not parish income/)
    expect(miAll).toMatch(/doesn\u2019t count toward the diocesan assessment/)
  })
  it('says which intentions can be deleted and that void needs a reason and a disposition', () => {
    expect(miAll).toMatch(/delete is refused for every role/)
    expect(miAll).toMatch(/Voiding is for administrators and needs a reason/)
    expect(miAll).toMatch(/refund it, transfer it to another open intention, or apply it as the pastor directs/)
    expect(miAll).toMatch(/Administrators use Void on the Intentions screen/)
    expect(miAll).toMatch(/Release stipend is not available yet/)
    expect(miAll).toMatch(/voiding a fulfilled intention that still holds the stipend is refused/)
    expect(miAll).not.toMatch(/Release stipend clears the held liability/)
  })
  it('says pending stipend dispositions block sending a period', () => {
    expect(fAll).toMatch(/voided Mass intention whose offering is still held/)
  })
  it('says pending deposit adjustments block send, approve, settle and assessment', () => {
    expect(fAll).toMatch(/deposit adjustments that aren\u2019t in the diocesan roll-up yet can\u2019t be sent, approved, or settled/)
  })
  it('FAQ no longer says offerings stay out of diocesan reporting', () => {
    const a = FAQ.find(x => /Mass offerings in my Donations totals/.test(x.q)).a
    expect(a).not.toMatch(/diocesan reporting stay clean/)
    expect(a).toMatch(/account 2330/)
  })
})
