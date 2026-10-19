import { describe, it, expect, beforeEach, vi } from 'vitest'
const { query, notify } = vi.hoisted(() => ({ query: vi.fn(), notify: vi.fn() }))
vi.mock('../src/db.js', () => ({ default: { query } }))
vi.mock('../src/notifications/transport.js', () => ({ notify }))
import { processDueNotifications, scheduleNotification } from '../src/notifications/scheduler.js'
beforeEach(() => { query.mockReset(); notify.mockReset() })
describe('organization HOLD queue preservation', () => {
  it('does not enqueue new work for a held tenant', async () => {
    query.mockResolvedValue({ rows: [] })
    expect(await scheduleNotification({ organizationId: 41, notification_type: 'weekly_serving_digest', sendAt: new Date() })).toBeUndefined()
    expect(query.mock.calls[0][0]).toContain('held_at IS NULL')
  })
  it('returns a raced claim to pending without recording a send or consuming a retry', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 }) // F-06 closed/deactivated recipient backstop
      .mockResolvedValueOnce({ rows: [{ id: 5, organization_id: 41, notification_type: 'weekly_serving_digest' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
    notify.mockResolvedValue({ status: 'skipped', reason: 'organization_held' })
    const result = await processDueNotifications()
    expect(result).toMatchObject({ processed: 1, sent: 0, failed: 0 })
    expect(query.mock.calls[3][0]).toContain('held_at IS NULL')
    expect(query.mock.calls[4][0]).toContain("status = 'pending'")
    expect(query.mock.calls[4][0]).toContain('GREATEST(attempts - 1, 0)')
  })
})
