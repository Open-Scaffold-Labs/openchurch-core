// POST /api/tasks treated category as optional. (Pass 7 §11)
//
// ochr_tasks.category is TEXT NOT NULL with no default, so an omitted
// category reached the constraint and came back as a bare 500 'Failed to
// create task'. Reproduced live on 27 Aug against the dev database, from the
// server log:
//
//   error: null value in column "category" of relation "ochr_tasks"
//          violates not-null constraint
//
// The intended contract is read off the schema and the existing writers, not
// invented: priority and status on the SAME table carry defaults and
// category does not; the client form has always sent one from a closed
// <select>; both seeders always supply one. Required, from a fixed set.
//
// These tests need no database — they exercise the boundary, which is the
// point of moving the check to the boundary.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TASK_CATEGORIES, categoryError } from '../src/routes/tasks.js'

describe('the task category vocabulary', () => {
  it('matches the client\'s list exactly — two declarations, one vocabulary', () => {
    const src = readFileSync(new URL('../../client/src/pages/Tasks.jsx', import.meta.url), 'utf8')
    const line = src.match(/const CATEGORIES\s*=\s*\[([^\]]*)\]/)
    expect(line, 'client CATEGORIES not found').toBeTruthy()
    const client = line[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    expect([...TASK_CATEGORIES].sort()).toEqual(client.sort())
  })

  it('every category the UI can show has a label — none falls through', () => {
    const src = readFileSync(new URL('../../client/src/pages/Tasks.jsx', import.meta.url), 'utf8')
    const meta = src.match(/const CATEGORY_META\s*=\s*\{([\s\S]*?)\n\}/)
    expect(meta, 'CATEGORY_META not found').toBeTruthy()
    for (const c of TASK_CATEGORIES) {
      expect(meta[1], `${c} has no CATEGORY_META entry`).toContain(`${c}:`)
    }
  })

  it('is the set the schema seeds were written against', () => {
    // migrate.js and sampleSeed.js both insert categories; every one of them
    // must be a member, or the app ships rows its own API would reject.
    for (const file of ['../src/migrate.js', '../src/onboarding/sampleSeed.js']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8')
      for (const m of src.matchAll(/category:\s*'([A-Z_]+)'/g)) {
        expect(TASK_CATEGORIES.has(m[1]), `${m[1]} in ${file} is not a valid category`).toBe(true)
      }
    }
  })
})

// The validator is IMPORTED, not retyped. The first version of this file
// defined its own copy with the same body, so neutering the real check in
// the route left every test green — a surviving mutant, and the same mistake
// Pass 6 made with a query retyped into a test. A test that re-implements
// the thing it is testing is testing itself.

describe('the boundary check', () => {
  it('accepts every category the client can send', () => {
    for (const c of TASK_CATEGORIES) expect(categoryError(c)).toBeNull()
  })

  for (const [label, value] of [
    ['omitted',    undefined],
    ['null',       null],
    ['empty',      ''],
    ['whitespace', '   '],
  ]) {
    it(`rejects a ${label} category with a message about the field`, () => {
      expect(categoryError(value)).toBe('category is required')
    })
  }

  it('rejects a value outside the vocabulary and names the alternatives', () => {
    // A typo used to be accepted and became a permanent bogus group on the
    // Tasks board, which renders whatever category string it is given.
    const msg = categoryError('DAILY_OPPS')
    expect(msg).toMatch(/must be one of/)
    expect(msg).toContain('DAILY_OPS')
  })

  it('is wired into both write paths, not just create', () => {
    const src = readFileSync(new URL('../src/routes/tasks.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(src.match(/const catErr = categoryError\(category\)/g)).toHaveLength(2)
  })
})
