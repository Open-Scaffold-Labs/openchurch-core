// I18N-L1-13 — the critical-surface harness must go red when the
// defect comes back. A green run on the tree is not the proof; the
// mutations below are.
//
//   node --test scripts/i18n-critical-surfaces.test.mjs

import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditRepo,
  auditSources,
  scanSource,
  evaluate,
  localeTables,
  loadClassification,
  repoSources,
  KNOWN_WALKER_MISSES,
  CLASSIFY_PATH,
  STRINGS_PATH,
} from './i18n-critical-surfaces.mjs'

const classification = loadClassification(readFileSync(CLASSIFY_PATH, 'utf8'))
const tables = localeTables(readFileSync(STRINGS_PATH, 'utf8'))
const EMPTY = { entries: {}, unresolved: [] }

const CONFLICT_KEYS = [
  'conflicts.title',
  'conflicts.leadOne',
  'conflicts.leadMany',
  'conflicts.scanAria',
  'conflicts.weekChip',
  'conflicts.emptyTitle',
  'conflicts.emptyBody',
  'conflicts.scanFailed',
  'conflicts.scanFailedStatus',
  'conflicts.summary11',
  'conflicts.summary1N',
  'conflicts.summaryN1',
  'conflicts.summaryNN',
  'conflicts.weekOfOne',
  'conflicts.weekOfMany',
  'conflicts.viewInSchedule',
]

const SHELL_KEYS = [
  'nav.Diocese',
  'shell.expandSidebar',
  'shell.collapseSidebar',
  'shell.openNav',
  'shell.openSearch',
  'shell.searchShort',
]

describe('I18N-L1-13 repo gate', () => {
  it('the current tree is classified and every resolved key exists in en and es', () => {
    const audited = auditRepo()
    assert.equal(audited.result.ok, true, audited.result.problems.join('\n'))
    assert.equal(audited.scan.dictionaryGaps.length, 0)
  })

  it('schedule-conflict primary chrome keys exist in both locales and Spanish is not a copy of English', () => {
    for (const key of CONFLICT_KEYS) {
      assert.equal(tables.en.has(key), true, key)
      assert.equal(tables.es.has(key), true, key)
      assert.notEqual(tables.en.get(key), tables.es.get(key), key)
    }
    assert.equal(tables.en.get('conflicts.title'), 'Schedule conflicts')
    assert.equal(tables.es.get('conflicts.title'), 'Conflictos en el calendario')
    assert.equal(tables.en.get('conflicts.viewInSchedule'), 'View in Schedule')
    assert.equal(tables.en.get('conflicts.emptyTitle'), 'No conflicts')
    assert.equal(tables.en.get('conflicts.scanFailed'), 'Failed to scan conflicts')
    assert.equal(tables.en.get('conflicts.scanFailedStatus'), 'Scan failed ({status})')
  })

  it('ScheduleConflicts primary chrome is on t(); meridiem and the row phrase stay held', () => {
    const page = repoSources().find(s => s.file === 'client/src/pages/ScheduleConflicts.jsx')
    const scan = scanSource(page.file, page.src, 'schedule')
    const ids = new Set(scan.findings.map(f => f.id))
    for (const gone of [
      'client/src/pages/ScheduleConflicts.jsx|jsx-text|Schedule conflicts',
      'client/src/pages/ScheduleConflicts.jsx|jsx-text|View in Schedule',
      'client/src/pages/ScheduleConflicts.jsx|attr:title|No conflicts',
      'client/src/pages/ScheduleConflicts.jsx|return|Week of {...}',
      'client/src/pages/ScheduleConflicts.jsx|jsx-text|across',
      'client/src/pages/ScheduleConflicts.jsx|jsx-text|conflict',
    ]) {
      assert.equal(ids.has(gone), false, gone)
    }
    for (const held of [
      'client/src/pages/ScheduleConflicts.jsx|meridiem|am',
      'client/src/pages/ScheduleConflicts.jsx|meridiem|pm',
      'client/src/pages/ScheduleConflicts.jsx|jsx-text|— double-booked',
    ]) {
      assert.equal(ids.has(held), true, [...ids].join('\n'))
    }
    assert.equal(ids.size, 3, [...ids].join('\n'))
    for (const key of CONFLICT_KEYS) {
      assert.ok(scan.resolvedKeys.some(k => k.key === key), key)
    }
  })

  it('the five shell keys exist in both locales and Spanish is not a copy of English', () => {
    for (const key of SHELL_KEYS) {
      assert.equal(tables.en.has(key), true, key)
      assert.equal(tables.es.has(key), true, key)
      assert.notEqual(tables.en.get(key), tables.es.get(key), key)
    }
    assert.equal(tables.en.get('nav.Diocese'), 'Diocese')
    assert.equal(tables.es.get('nav.Diocese'), 'Diócesis')
    assert.equal(tables.es.get('shell.searchShort'), 'Buscar')
    assert.equal(tables.es.get('shell.openNav'), 'Abrir el menú de navegación')
  })

  it('ProfileDropdown role and name fallbacks go through t(), not hidden English initializers', () => {
    const app = repoSources().find(s => s.file === 'client/src/App.jsx')
    assert.deepEqual(KNOWN_WALKER_MISSES, [])
    assert.equal(app.src.includes('OpenChurch Admin'), false)
    assert.equal(app.src.includes("'Administrator'"), false)
    assert.equal(app.src.includes('"Administrator"'), false)
    assert.match(app.src, /t\('shell\.role\.admin'\)/)
    assert.match(app.src, /t\('shell\.role\.staff'\)/)
    assert.match(app.src, /t\('shell\.role\.viewer'\)/)
    assert.match(app.src, /t\('shell\.account\.fallbackName'\)/)
    assert.match(app.src, /t\('dash\.member'\)/)
  })
})

describe('I18N-L1-13 falsify', () => {
  it('an unclassified accessible name on the shell fails', () => {
    const src = 'export function X(){ return <button aria-label="Count the collection" /> }'
    const scan = scanSource('client/src/App.jsx', src, 'shell')
    const result = evaluate(scan, tables, EMPTY)
    assert.equal(result.ok, false)
    assert.ok(
      result.problems.some(p => p.startsWith('UNCLASSIFIED') && p.includes('Count the collection')),
      result.problems.join('\n'),
    )
  })

  it('reintroducing Search as a jsx expression is pinned even when filed as hold', () => {
    const sources = [
      "export function X(){ return <span>{'Search'}</span> }",
      'export function X(){ return <span>{"Search"}</span> }',
    ]
    const id = 'client/src/App.jsx|jsx-expr|Search'
    for (const src of sources) {
      const scan = scanSource('client/src/App.jsx', src, 'shell')
      assert.ok(scan.findings.some(f => f.id === id), scan.findings.map(f => f.id).join('\n'))
      const result = evaluate(scan, tables, {
        entries: { [id]: { class: 'hold', note: 'trying to silence the mobile Search pin' } },
        unresolved: [],
      })
      assert.equal(result.ok, false)
      assert.ok(result.problems.some(p => p.startsWith('REINTRODUCED') && p.includes(id)), result.problems.join('\n'))
    }
  })

  it('reintroducing Mark all read is pinned even when filed as hold', () => {
    const src = 'export function X(){ return <button>Mark all read</button> }'
    const scan = scanSource('client/src/App.jsx', src, 'shell')
    const id = 'client/src/App.jsx|jsx-text|Mark all read'
    assert.ok(scan.findings.some(f => f.id === id), scan.findings.map(f => f.id).join('\n'))
    const result = evaluate(scan, tables, {
      entries: { [id]: { class: 'hold', note: 'trying to silence the notification panel pin' } },
      unresolved: [],
    })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some(p => p.startsWith('REINTRODUCED') && p.includes(id)), result.problems.join('\n'))
  })

  it('reintroducing Edit intention is pinned even when filed as hold', () => {
    const src = 'export function X(){ return <button aria-label="Edit intention" /> }'
    const scan = scanSource('client/src/pages/MassIntentions.jsx', src, 'intentions')
    const id = 'client/src/pages/MassIntentions.jsx|attr:aria-label|Edit intention'
    assert.ok(scan.findings.some(f => f.id === id), scan.findings.map(f => f.id).join('\n'))
    const result = evaluate(scan, tables, {
      entries: { [id]: { class: 'hold', note: 'trying to silence the intention-book pin' } },
      unresolved: [],
    })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some(p => p.startsWith('REINTRODUCED') && p.includes(id)), result.problems.join('\n'))
  })

  it('reintroducing Schedule conflicts is pinned even when filed as hold', () => {
    const src = 'export function X(){ return <h1>Schedule conflicts</h1> }'
    const scan = scanSource('client/src/pages/ScheduleConflicts.jsx', src, 'schedule')
    const id = 'client/src/pages/ScheduleConflicts.jsx|jsx-text|Schedule conflicts'
    assert.ok(scan.findings.some(f => f.id === id), scan.findings.map(f => f.id).join('\n'))
    const result = evaluate(scan, tables, {
      entries: { [id]: { class: 'hold', note: 'trying to silence the conflicts title pin' } },
      unresolved: [],
    })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some(p => p.startsWith('REINTRODUCED') && p.includes(id)), result.problems.join('\n'))
  })

  it('dropping es conflicts.title fails — the page title binding is live', () => {
    const sources = repoSources().filter(s => s.file === 'client/src/pages/ScheduleConflicts.jsx')
    const es = new Map(tables.es)
    assert.equal(es.delete('conflicts.title'), true)
    const result = auditSources(sources, { en: tables.en, es }, classification).result
    assert.ok(result.problems.some(p => p.includes('MISSING es conflicts.title')), result.problems.join('\n'))
  })

  it('reintroducing Close search is pinned even when filed as hold', () => {
    const src = 'export function X(){ return <button aria-label="Close search" /> }'
    const scan = scanSource('client/src/components/GlobalSearchPalette.jsx', src, 'shell')
    const id = 'client/src/components/GlobalSearchPalette.jsx|attr:aria-label|Close search'
    assert.ok(scan.findings.some(f => f.id === id), scan.findings.map(f => f.id).join('\n'))
    const result = evaluate(scan, tables, {
      entries: { [id]: { class: 'hold', note: 'trying to silence the search palette pin' } },
      unresolved: [],
    })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some(p => p.startsWith('REINTRODUCED') && p.includes(id)), result.problems.join('\n'))
  })

  it('filing a pinned literal as hold does not silence it', () => {
    const src = 'export function X(){ return <button aria-label="Open navigation menu" /> }'
    const scan = scanSource('client/src/App.jsx', src, 'shell')
    const id = 'client/src/App.jsx|attr:aria-label|Open navigation menu'
    const result = evaluate(scan, tables, {
      entries: { [id]: { class: 'hold', note: 'trying to silence a release pin' } },
      unresolved: [],
    })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some(p => p.startsWith('REINTRODUCED') && p.includes(id)), result.problems.join('\n'))
  })

  it('dropping es nav.Diocese fails — the nav label binding is live', () => {
    const sources = repoSources().filter(s => s.file === 'client/src/App.jsx')
    const es = new Map(tables.es)
    assert.equal(es.delete('nav.Diocese'), true)
    const result = auditSources(sources, { en: tables.en, es }, classification).result
    assert.ok(result.problems.some(p => p.includes('MISSING es nav.Diocese')), result.problems.join('\n'))
  })

  it('dropping es cert.title.baptism fails — CERT_TYPES is bound to the template', () => {
    const sources = repoSources().filter(s => s.file === 'client/src/pages/SacramentCertificate.jsx')
    const es = new Map(tables.es)
    assert.equal(es.delete('cert.title.baptism'), true)
    const result = auditSources(sources, { en: tables.en, es }, classification).result
    assert.ok(
      result.problems.some(p => p.includes('MISSING es cert.title.baptism')),
      result.problems.join('\n'),
    )
  })

  it('a local en key with no es twin fails, and the dictionary value is not also called prose', () => {
    const src = [
      'const COPY = { en: { demo: "Use demo account" }, es: {} }',
      'export default function L(){ return <button>{COPY.en.demo}</button> }',
    ].join('\n')
    const scan = scanSource('client/src/pages/loginDemo.jsx', src, 'auth')
    assert.equal(scan.findings.some(f => f.text === 'Use demo account'), false)
    const result = evaluate(scan, tables, EMPTY)
    assert.ok(result.problems.some(p => p.includes('LOCAL DICTIONARY missing es "demo"')), result.problems.join('\n'))
  })

  it('a t() key is a key, not hard-coded English', () => {
    const src = 'export function X(){ return <button aria-label={t("shell.openSearch")}>{t("shell.searchShort")}</button> }'
    const scan = scanSource('client/src/App.jsx', src, 'shell')
    assert.equal(scan.findings.length, 0)
    assert.ok(scan.resolvedKeys.some(k => k.key === 'shell.openSearch'))
    assert.ok(scan.resolvedKeys.some(k => k.key === 'shell.searchShort'))
  })

  it('marketing pages and Spanish About are outside the surface list', () => {
    const files = repoSources().map(s => s.file)
    assert.equal(files.some(f => f.includes('PublicChurch')), false)
    assert.equal(files.some(f => /About/i.test(f)), false)
    assert.equal(files.some(f => f.includes('client-diocese')), false)
  })
})
