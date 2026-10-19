// ARG-LEAK-7: report CSV neutralises formula-leading cells (=, +, -, @,
// tab, CR) and keeps plain numbers numeric. Pure unit test, no DB.
import { describe, it, expect } from 'vitest'
import { toCSV } from '../src/reporting/run.js'

const res = (fields) => ({ fields, disclaimer: '=DISCLAIMER()' })
const f = (label, value, note = '') => ({ label, value, requirement: 'req', source: 'src', note })
const rowOf = (csv, i) => csv.split('\n')[i + 1]

describe('ARG-LEAK-7 report CSV formula guard', () => {
  it.each([
    ['=HYPERLINK("http://x","y")'], ['+cmd|\' /C calc\'!A0'], ['-2+3'], ['@SUM(A1)'], ['\tTAB'], ['\rCR'],
  ])('prefixes %j with an apostrophe', (evil) => {
    const csv = toCSV(res([f(evil, evil, evil)]))
    const row = rowOf(csv, 0)
    const cells = row.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0)
    for (const c of [cells[0], cells[1], cells[4]]) {
      const unq = c.startsWith('"') ? c.slice(1, -1).replaceAll('""', '"') : c
      expect(unq.startsWith("'")).toBe(true)
    }
  })
  it('leaves plain numbers (incl. negatives) and ordinary text alone', () => {
    const csv = toCSV(res([f('Total', -12.5), f('Count', '42'), f('Net', '-7.25'), f('Name', 'St. Brigid')]))
    expect(rowOf(csv, 0)).toBe('Total,-12.5,req,src,')
    expect(rowOf(csv, 1)).toBe('Count,42,req,src,')
    expect(rowOf(csv, 2)).toBe('Net,-7.25,req,src,')
    expect(rowOf(csv, 3)).toBe('Name,St. Brigid,req,src,')
  })
  it('guards the disclaimer line too', () => {
    expect(toCSV(res([])).split('\n').pop()).toBe("'=DISCLAIMER()")
  })
})
