// Maintenance 2026-10-30: Help must describe the Parish page publish screen
// from OC-WEB-1 PR-D (#465; SitePublish.jsx at /settings/site: draft kept
// apart, Publish / Take the page down / Restore the previous page, each
// confirmed; visible only while page_published is on), and must say closing
// a non-zero cash count asks first (#478).
import { describe, it, expect } from 'vitest'
import { MODULE_HELP as HELP } from './helpContent.js'

const s = HELP.settings
const sAll = [s.overview, ...s.features, ...s.tips, ...s.sections.map(x => `${x.title}\n${x.content}`)].join('\n')
const d = HELP.donations
const dAll = d.sections.map(x => x.content || '').join('\n')

describe('Parish page and cash count help (2026-10-30)', () => {
  it('names the Parish page publish screen and its three confirmed actions', () => {
    expect(sAll).toMatch(/Publish the parish page/)
    expect(sAll).toMatch(/Publish, Take the page down and Restore the previous page, each confirmed first/)
  })
  it('says the draft changes nothing visitors see until published', () => {
    expect(sAll).toMatch(/changing the draft changes nothing visitors see until you choose Publish and confirm/)
  })
  it('says the public address switch must be on for visitors to see it', () => {
    expect(sAll).toMatch(/a published page with the switch off is still not visible/)
    expect(sAll).not.toMatch(/service times, publish toggle/)
  })
  it('cash count help says closing with money entered asks first', () => {
    expect(dAll).toMatch(/Nothing is kept until you save/)
    expect(dAll).toMatch(/asks before throwing that count away/)
  })
})
