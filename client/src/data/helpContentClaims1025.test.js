// Maintenance 2026-10-25 — Help must describe what the app actually does.
// Each case failed on the copy at origin/main 51f2517d.
import { describe, it, expect } from 'vitest'
import { MODULE_HELP, FAQ, ROLE_TABLE } from './helpContent.js'

const faq = q => FAQ.find(f => f.q.startsWith(q))?.a ?? ''
const allText = () => JSON.stringify({ MODULE_HELP, FAQ })

describe('help claims (2026-10-25)', () => {
  it('no room booking or room conflicts: rooms are check-in spaces; Conflicts scans members only', () => {
    const t = allText()
    expect(t).not.toMatch(/Room booking|double-booked rooms|Room double-bookings/i)
    expect(JSON.stringify(MODULE_HELP.conflicts)).toMatch(/Rooms are not checked/)
  })

  it('certificate numbers: no proposed next number, no duplicate check, no "sequential" promise', () => {
    const t = allText()
    expect(t).not.toMatch(/proposes the next number|duplicates are not|keeps the book\u2019s sequence|sequential/i)
    expect(JSON.stringify(MODULE_HELP.register)).toMatch(/check for duplicates/)
    expect(faq('How do I record a baptism')).toMatch(/check for duplicates/)
  })

  it('viewers: Help says member notes and birth years are hidden (SP-176)', () => {
    const team = JSON.stringify(MODULE_HELP.team)
    expect(team).toMatch(/private notes, birth years/)
    expect(faq('Can volunteers see the schedule')).toMatch(/private notes or birth years/)
    expect(MODULE_HELP.members.overview).toMatch(/for staff and admins, their giving history/)
    expect(ROLE_TABLE.length).toBeGreaterThan(0)
  })

  it('pledges: no diocese roll-up promise', () => {
    const p = JSON.stringify(MODULE_HELP.pledges)
    expect(p).not.toMatch(/diocese layer read the roll-up/)
    expect(p).toMatch(/doesn\u2019t read them/)
  })

  it('recurring tasks: a label, not regeneration', () => {
    const tasks = JSON.stringify(MODULE_HELP.tasks)
    expect(tasks).not.toMatch(/regenerate themselves/)
    expect(tasks).toMatch(/doesn\u2019t come back by itself/)
  })
})
