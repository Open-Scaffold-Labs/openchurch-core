// SP-117..121 (Saint 390px polish sweep, 2026-10-23). jsdom cannot measure
// layout, so these pin the class/copy contracts behind each fix.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Award } from 'lucide-react'
import { SummaryCard } from './Donations'
import { IntentionMassCell } from './MassIntentions'
import { STRINGS } from '../i18n/strings'
const { en, es } = STRINGS

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(SRC, rel), 'utf8')
const tEn = k => en[k] ?? k

describe('SP-119 money summary card', () => {
  it('shows the full amount with no ellipsis truncation', () => {
    render(<SummaryCard icon={Award} label="Largest Gift" value="$1,250.00" sub="Single donation" accent="amber" />)
    const v = screen.getByText('$1,250.00')
    expect(v.className).not.toMatch(/\btruncate\b/)
    expect(v.className).toMatch(/overflow-wrap:anywhere/)
  })
})

describe('SP-121 intention with no Mass date', () => {
  it('says "No date set" instead of a bare dash', () => {
    render(<IntentionMassCell r={{ status: 'open', mass_date: null, mass_title: null }} t={tEn} dateLocale="en-US" />)
    expect(screen.getByText('No date set')).toBeInTheDocument()
    expect(screen.queryByText('—')).toBeNull()
  })
  it('has Spanish copy', () => {
    expect(es['mi.noDateSet']).toBeTruthy()
  })
})

describe('SP-117 assistant quill clearance', () => {
  it('reserves bottom space (with safe-area inset) on the main scroll area', () => {
    expect(read('App.jsx')).toMatch(/<main className="oc-fab-clearance /)
    expect(read('index.css')).toMatch(/\.oc-fab-clearance\s*\{\s*padding-bottom:\s*calc\(5\.5rem \+ env\(safe-area-inset-bottom, 0px\)\)/)
  })
})

describe('SP-118 narrow-width stats and tables', () => {
  it('Members stat cards wrap into a grid', () => {
    expect(read('pages/Clients.jsx')).toMatch(/data-testid="member-stats" className="grid grid-cols-2 lg:grid-cols-3/)
  })
  it.each(['pages/Clients.jsx', 'pages/Events.jsx'])('%s table has a sideways-scroll hint and focusable region', f => {
    const s = read(f)
    expect(s).toMatch(/data-testid="table-scroll-hint"/)
    expect(s).toMatch(/overflow-x-auto(?: print:overflow-visible)?" tabIndex=\{0\} role="region"/)
  })
})

describe('SP-120 truncated labels', () => {
  it('AI Studio template tile titles wrap', () => {
    expect(read('pages/AI.jsx')).not.toMatch(/truncate">\{t\(`aist\.type/)
  })
  it('check-in repeats the full chosen service on phones', () => {
    expect(read('pages/Checkin.jsx')).toMatch(/data-testid="checkin-service-full"[\s\S]*after:content-\[attr\(data-label\)\]/)
  })
  it('intention placeholder is short enough for a phone field', () => {
    expect(en['mi.placeholder'].length).toBeLessThanOrEqual(36)
  })
})
