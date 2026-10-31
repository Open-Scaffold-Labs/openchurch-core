import { describe, expect, it } from 'vitest'
import {
  giftOpenedOutsideNote,
  giftPageDidNotOpenNote,
  planPurchaseOfferedInShell,
  shellPlanNote,
} from './planPurchase'

describe('plan purchase in the iOS shell', () => {
  it('offers purchase on the web and withholds it in the shell', () => {
    expect(planPurchaseOfferedInShell(false)).toBe(true)
    expect(planPurchaseOfferedInShell(undefined)).toBe(true)
    expect(planPurchaseOfferedInShell(true)).toBe(false)
  })

  it('says the app is free and nothing is charged here, in English and Spanish', () => {
    expect(shellPlanNote('en')).toMatch(/is free/)
    expect(shellPlanNote('en')).toMatch(/Nothing is sold or charged in this app/)
    expect(shellPlanNote('es')).toMatch(/es gratuita/)
    expect(shellPlanNote('es')).not.toMatch(/is free/)
    expect(shellPlanNote('fr')).toMatch(/is free/)
    // C2: no steering to a web purchase from inside the app.
    expect(shellPlanNote('en')).not.toMatch(/web|upgrade|plan change/i)
  })

  it('does not claim a gift was recorded when the outside page opens or fails', () => {
    expect(giftOpenedOutsideNote('en')).toMatch(/outside this app/)
    expect(giftOpenedOutsideNote('en')).not.toMatch(/received|recorded|charged/i)
    expect(giftOpenedOutsideNote('es')).toMatch(/fuera de esta aplicación/)
    expect(giftPageDidNotOpenNote('en')).toMatch(/could not confirm/)
    expect(giftPageDidNotOpenNote('en')).not.toMatch(/did not open|was not completed/)
    expect(giftPageDidNotOpenNote('es')).toMatch(/No pudimos confirmar/)
    expect(giftPageDidNotOpenNote('es')).not.toMatch(/no se abrió|no se completó/)
  })
})
