// SP-097 (Saint 2026-10-22): Help had nothing on moving an intention —
// "move", "reschedule", "change Mass" and "change date" all came back empty.
import { describe, it, expect } from 'vitest'
import { MODULE_HELP, buildSearchIndex } from './helpContent'

// Same matching HelpPanel uses: case-insensitive substring on title or text.
const search = (q) => buildSearchIndex().filter(r =>
  r.title.toLowerCase().includes(q.toLowerCase()) || r.text.toLowerCase().includes(q.toLowerCase()))

describe('Help: moving an intention', () => {
  for (const q of ['move', 'reschedule', 'change Mass', 'change date']) {
    it(`searching "${q}" finds the move-an-intention help`, () => {
      const hits = search(q)
      expect(hits.some(r => r.id === 'intentions' && /Move an intention/.test(r.title))).toBe(true)
    })
  }

  it('describes the real steps and the save rule', () => {
    const sec = MODULE_HELP.intentions.sections.find(s => /Move an intention/.test(s.title))
    expect(sec.content).toMatch(/Edit/)
    expect(sec.content).toMatch(/Add a Mass on this date/)
    expect(sec.content).toMatch(/Save changes/)
    expect(sec.content).toMatch(/nothing saves until you press Save changes/)
  })
})
