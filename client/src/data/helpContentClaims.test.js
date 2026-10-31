// Maintenance 2026-10-22: help text must describe screens that exist.
// Each assertion pins a claim that used to point at a removed or
// non-existent feature (Get Started checklist, Org details kiosk token,
// Org details "clear samples", a copy-a-plan action, form responses
// feeding Members).
import { describe, it, expect } from 'vitest'
import { MODULE_HELP, TIPS } from './helpContent'

const all = JSON.stringify({ MODULE_HELP, TIPS })

describe('help content claims match the app', () => {
  it('describes the Getting settled card, not the removed Get Started checklist', () => {
    expect(all).not.toMatch(/Get Started/)
    expect(all).not.toMatch(/checks itself off/)
    expect(MODULE_HELP.dashboard.sections.some(s => s.title === 'Getting settled')).toBe(true)
  })

  it('places the kiosk link on the Check-in page, not Org details', () => {
    expect(JSON.stringify(MODULE_HELP.settings)).not.toMatch(/[Kk]iosk/)
    expect(MODULE_HELP.checkin.features.join(' ')).toMatch(/Check-in page/)
  })

  it('sends sample-data clearing to the Dashboard banner', () => {
    expect(all).not.toMatch(/Org details → clear samples/)
    expect(TIPS.join(' ')).toMatch(/Dashboard banner/)
  })

  it('does not promise a copy-a-plan action in Worship', () => {
    expect(JSON.stringify(MODULE_HELP.worship)).not.toMatch(/[Dd]uplicate/)
  })

  it('does not say form responses feed Members', () => {
    expect(JSON.stringify(MODULE_HELP.forms)).not.toMatch(/feeds Members/)
    expect(MODULE_HELP.forms.tips.join(' ')).toMatch(/don\u2019t add anyone to Members/)
  })

  it('AI keys: the parish brings its own; there is no platform key to fall back on', () => {
    expect(all).not.toMatch(/platform\u2019s keys|platform's keys/)
    expect(all).not.toMatch(/Own AI key \(optional\)/)
    expect(JSON.stringify(MODULE_HELP['ai-studio'])).toMatch(/does not supply a key/)
  })
})
