// Saint evening 2026-10-28 + WebKit 2026-10-29 UI polish (SP-279…292).
// Source-level guards — keep the phone/WebKit fixes from regressing.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STRINGS } from '../i18n/strings'
import { visibleNavFor } from '../App'
import { viewerMayOpen } from '../auth/viewerPages'

const dir = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(dir, '..', rel), 'utf8')

describe('SP-279 title wraps on phone', () => {
  it('TaskCard title is break-words, not truncate', () => {
    const src = read('pages/Tasks.jsx')
    // The card title span must wrap; other truncates (member picker) may stay.
    expect(src).toMatch(/SP-279[\s\S]*?break-words/)
    expect(src).not.toMatch(/text-sm font-semibold truncate/)
  })
})

describe('SP-280 one-tap complete', () => {
  it('Pending and In Progress both advance to COMPLETED', () => {
    const src = read('pages/Tasks.jsx')
    expect(src).toMatch(/PENDING:\s*'COMPLETED'/)
    expect(src).toMatch(/IN_PROGRESS:\s*'COMPLETED'/)
    expect(src).toMatch(/task\.markedComplete/)
  })
})

describe('SP-281 New Task sheet geometry', () => {
  it('scroll body is flex-1 min-h-0; footer is shrink-0', () => {
    const src = read('pages/Tasks.jsx')
    expect(src).toMatch(/flex-1 min-h-0 overflow-y-auto/)
    expect(src).toMatch(/shrink-0 flex justify-end gap-3/)
  })
})

describe('SP-282 create toast', () => {
  it('create path toasts task.created when first-action delight does not fire', () => {
    const src = read('pages/Tasks.jsx')
    expect(src).toMatch(/toast\.success\(t\('task\.created'\)\)/)
  })
})

describe('SP-283 InstallPrompt clears FAB', () => {
  it('banner leaves right gutter for the Assistant FAB on phone', () => {
    const src = read('components/InstallPrompt.jsx')
    expect(src).toMatch(/right-20/)
    expect(src).toMatch(/min-h-\[44px\] min-w-\[44px\]/)
  })
})

describe('SP-284 priority text + 44px chips', () => {
  it('row names priority; group chips and checklist chevron are ≥44px', () => {
    const src = read('pages/Tasks.jsx')
    expect(src).toMatch(/priLabel\(t, task\.priority/)
    expect(src).toMatch(/min-h-\[44px\].*groupBy|groupBy[\s\S]*min-h-\[44px\]/)
    expect(src).toMatch(/min-h-\[44px\] min-w-\[44px\]/)
  })
})

describe('SP-285 honest overall progress + lining nums', () => {
  it('uses overallProgress and tabular/lining nums on StatPill', () => {
    const src = read('pages/Tasks.jsx')
    expect(src).toMatch(/task\.overallProgress/)
    expect(src).toMatch(/lining-nums tabular-nums/)
  })
})

describe('SP-286 print', () => {
  it('exposes a Print control that calls window.print', () => {
    const src = read('pages/Tasks.jsx')
    expect(src).toMatch(/window\.print\(\)/)
    expect(src).toMatch(/task\.print/)
  })
})

describe('SP-287 select labels', () => {
  it('Category/Priority/Status/Recurring use htmlFor + id', () => {
    const src = read('pages/Tasks.jsx')
    for (const id of ['task-category', 'task-priority', 'task-status', 'task-recurring', 'task-due']) {
      expect(src).toContain(`htmlFor="${id}"`)
      expect(src).toContain(`id="${id}"`)
    }
  })
})

describe('SP-289 / B-463-1 16px inputs on coarse pointers', () => {
  it('raises input, select, and textarea to 16px with !important so text-sm cannot win', () => {
    const css = read('index.css')
    const m = css.match(/@media \(pointer: coarse\) \{[\s\S]*?input:not\(\[type='checkbox'\]\)[\s\S]*?textarea \{([\s\S]*?)\}/)
    expect(m, 'coarse field block').toBeTruthy()
    const block = m[1]
    expect(block).toMatch(/font-size:\s*16px\s*!important/)
    // Selector must name all three control kinds Saint/Beacon measured.
    expect(css).toMatch(/input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\):not\(\[type='hidden'\]\),\s*\n\s*select,\s*\n\s*textarea/)
  })

  it('Connect textarea still carries text-sm (utility) — the CSS rule must outrank it', () => {
    const src = read('pages/PublicChurch.jsx')
    // inputCls includes text-sm; textarea uses it. Regression guard for B-463-1.
    expect(src).toMatch(/const inputCls = '[^']*\btext-sm\b/)
    expect(src).toMatch(/id="connect-message"[\s\S]*?className=\{\`\$\{inputCls\}/)
  })
})

describe('SP-290 Viewer Mass Intentions nav + copy', () => {
  it('viewerMayOpen still refuses the book editor', () => {
    expect(viewerMayOpen('/mass-intentions')).toBe(false)
    expect(viewerMayOpen('/mass-intentions/print')).toBe(true)
  })
  it('Viewer nav rewrites Intentions to the weekly sheet', () => {
    const nav = visibleNavFor('viewer', false, 'web')
    const intentions = nav.find(i => i.label === 'Intentions')
    expect(intentions).toBeTruthy()
    expect(intentions.to).toBe('/mass-intentions/print')
  })
  it('Staff nav still opens the book', () => {
    const nav = visibleNavFor('staff', false, 'web')
    expect(nav.find(i => i.label === 'Intentions').to).toBe('/mass-intentions')
  })
  it('Viewer gated copy names Mass Intentions in en and es', () => {
    expect(STRINGS.en['viewer.notAvailableBody']).toMatch(/Mass Intentions/)
    expect(STRINGS.es['viewer.notAvailableBody']).toMatch(/Intenciones/)
  })
})

describe('SP-291 cash count sticky footer clearance', () => {
  it('pads the cash-count scroll body above Guardar', () => {
    const src = read('pages/Donations.jsx')
    expect(src).toMatch(/SP-291[\s\S]*?pb-28/)
  })
})

describe('SP-292 Members sticky ≥44px actions', () => {
  it('pins actions and sizes the menu trigger to 44px', () => {
    const src = read('pages/Clients.jsx')
    expect(src).toMatch(/sticky right-0[\s\S]*?ActionsMenu|ActionsMenu[\s\S]*?sticky right-0/)
    expect(src).toMatch(/min-h-\[44px\] min-w-\[44px\]/)
    expect(src).not.toMatch(/opacity-0 group-hover:opacity-100/)
  })
})

describe('Beacon #460 notes', () => {
  it('high-contrast focus ring is black; #connect is focusable', () => {
    expect(read('index.css')).toMatch(/\[data-os-look="high-contrast"\] :focus-visible/)
    expect(read('pages/PublicChurch.jsx')).toMatch(/id="connect"[\s\S]*?tabIndex=\{-1\}/)
  })
})

describe('B-463-2 Connect visible labels (htmlFor/id)', () => {
  const fields = [
    ['connect-interest', 'contact.interest'],
    ['connect-name', 'contact.name'],
    ['connect-email', 'contact.email'],
    ['connect-phone', 'contact.phone'],
    ['connect-message', 'contact.message'],
  ]

  it('each Connect control has a matching label htmlFor + id', () => {
    const src = read('pages/PublicChurch.jsx')
    for (const [id, key] of fields) {
      expect(src).toContain(`htmlFor="${id}"`)
      expect(src).toContain(`id="${id}"`)
      expect(src).toContain(`t('${key}')`)
    }
  })

  it('label keys exist in en and es and are not English copies in es', () => {
    for (const [, key] of fields) {
      expect(STRINGS.en[key]).toBeTruthy()
      expect(STRINGS.es[key]).toBeTruthy()
    }
    expect(STRINGS.es['contact.name']).not.toBe(STRINGS.en['contact.name'])
    expect(STRINGS.es['contact.message']).not.toBe(STRINGS.en['contact.message'])
  })

  it('does not rely on aria-label alone for Connect name/email/phone/message', () => {
    const src = read('pages/PublicChurch.jsx')
    // After B-463-2 the visible label is the accessible name.
    expect(src).not.toMatch(/id="connect-name"[\s\S]{0,200}aria-label=/)
    expect(src).not.toMatch(/contact\.namePh'\)\s*aria-label/)
  })
})

describe('en/es parity for new task polish keys', () => {
  const keys = [
    'task.overallProgress', 'task.created', 'task.markedComplete',
    'task.reopened', 'task.print',
  ]
  for (const k of keys) {
    it(`${k} exists in en and es`, () => {
      expect(STRINGS.en[k]).toBeTruthy()
      expect(STRINGS.es[k]).toBeTruthy()
    })
  }
})
