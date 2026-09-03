// The response contract for tasks and events (Pass 6 §4).
//
// Both tables carry a GENERATED tsvector. Their LIST endpoints have projected
// since Pass 5; their linked-resource siblings did not, and shipped it:
//
//   GET /api/events/:id/tasks   → `SELECT t.*`  → search_vec, measured 27 Aug
//   GET /api/tasks/:id/events   → `SELECT e.*`  → search_vec, measured 27 Aug
//
// The lists could not simply be imported across the two routers (that is a
// cycle) and must not be copied into both (that is how the contract drifted
// in the first place), so they live in one module. These tests pin what that
// module says, and that neither router still says `*`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TASK_COLUMNS, EVENT_COLUMNS } from '../src/routes/publicColumns.js'

const INTERNAL = ['search_vec']

describe('public column contracts', () => {
  it('name every column explicitly and none of the internal ones', () => {
    for (const c of [TASK_COLUMNS, EVENT_COLUMNS]) {
      expect(c.columns.length).toBeGreaterThan(5)
      expect(c.columns).not.toContain('*')
      for (const internal of INTERNAL) expect(c.columns).not.toContain(internal)
    }
  })

  it('prefix cleanly for joined queries — the shape SELECT t.* was hiding', () => {
    const sql = TASK_COLUMNS.prefixed('t')
    expect(sql.startsWith('t.id, t.organization_id')).toBe(true)
    expect(sql.split(', ').every(c => c.startsWith('t.'))).toBe(true)
    expect(sql.split(', ')).toHaveLength(TASK_COLUMNS.columns.length)
    expect(EVENT_COLUMNS.prefixed('e').split(', ').every(c => c.startsWith('e.'))).toBe(true)
  })

  it('pin the task contract, so dropping a field is a decision and not an accident', () => {
    expect(TASK_COLUMNS.columns).toEqual([
      'id', 'organization_id', 'title', 'description', 'category', 'assigned_to',
      'assigned_member_id', 'priority', 'status', 'recurring_freq', 'checklist',
      'due_date', 'created_at', 'completed_at',
    ])
  })

  it('pin the event contract', () => {
    expect(EVENT_COLUMNS.columns).toEqual([
      'id', 'organization_id', 'title', 'service_division', 'date', 'time',
      'location', 'liturgical_season', 'liturgical_color', 'feast_name',
      'language', 'is_public', 'created_at',
    ])
  })
})

// A guard on the six sites fixed in Pass 6 §4. Reading the file is crude, but
// these are the exact lines that regressed once already, and a behavioural
// test needs a database this sandbox could not reach when they were fixed.
describe('the six sites that shipped internal columns', () => {
  // Strip comments first. The first version of this test failed on its own
  // documentation: the fix comments quote the defective SQL ("`SELECT t.*`
  // shipped …") and a raw text match cannot tell an explanation from an
  // instruction. Same mistake the honest-failure linter made in Pass 3.
  const stripComments = src => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const read = f => stripComments(
    readFileSync(new URL(`../src/routes/${f}`, import.meta.url), 'utf8'))

  it('clients create and update no longer return the whole row', () => {
    const src = read('clients.js')
    expect(src).not.toMatch(/RETURNING \*/)
    expect(src.match(/RETURNING \$\{CLIENT_PUBLIC_COLUMNS\}/g)?.length).toBeGreaterThanOrEqual(2)
    // The two credentials this allowlist exists to withhold.
    expect(src).toMatch(/const CLIENT_PUBLIC_COLUMNS/)
    for (const secret of ['calendar_token', 'swap_token', 'search_vec']) {
      const list = src.split('const CLIENT_PUBLIC_COLUMNS')[1].split('].join')[0]
      expect(list).not.toContain(secret)
    }
  })

  it('payroll staff create and update no longer return the whole row', () => {
    const src = read('payroll.js')
    expect(src).not.toMatch(/ochr_payroll_staff[\s\S]{0,200}?RETURNING \*/)
    expect(src.match(/RETURNING \$\{STAFF_PUBLIC_COLUMNS\}/g)).toHaveLength(2)
  })

  it('the linked-resource joins no longer select a whole aliased row', () => {
    expect(read('events.js')).not.toMatch(/SELECT t\.\*/)
    expect(read('tasks.js')).not.toMatch(/SELECT e\.\*/)
  })
})
