import { describe, it, expect } from 'vitest'
import { viewerMayRead, viewerMayOpen, VIEWER_OPTIONS } from '../src/middleware/viewerScope.js'

describe('Viewer option toggles (one allow-list)', () => {
  it('defaults keep Archive and Events/Tasks closed', () => {
    expect(VIEWER_OPTIONS).toEqual({ archive: false, eventsTasks: false })
    for (const u of ['/api/vault', '/api/events', '/api/tasks/stats']) expect(viewerMayRead(u)).toBe(false)
    for (const p of ['/archive', '/events', '/tasks']) expect(viewerMayOpen(p)).toBe(false)
  })
  it('archive opens /api/vault and /archive only', () => {
    const o = { archive: true }
    expect(viewerMayRead('/api/vault/items?x=1', o)).toBe(true)
    expect(viewerMayOpen('/archive', o)).toBe(true)
    expect(viewerMayRead('/api/events', o)).toBe(false)
  })
  it('eventsTasks opens events and tasks but never attendance', () => {
    const o = { eventsTasks: true }
    expect(viewerMayRead('/api/events?limit=200', o)).toBe(true)
    expect(viewerMayRead('/api/tasks/stats', o)).toBe(true)
    expect(viewerMayRead('/api/events/5/attendance', o)).toBe(false)
    expect(viewerMayOpen('/events', o) && viewerMayOpen('/tasks', o)).toBe(true)
    expect(viewerMayRead('/api/vault', o)).toBe(false)
  })
  it('base pages unchanged', () => {
    for (const p of ['/', '/clients', '/clients/12', '/schedule', '/getting-settled', '/preferences']) expect(viewerMayOpen(p)).toBe(true)
    expect(viewerMayOpen('/finance')).toBe(false)
  })
})
