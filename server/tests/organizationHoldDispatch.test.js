import { describe, it, expect, beforeEach, vi } from 'vitest'
const { query, sendEmail, sendPush } = vi.hoisted(() => ({ query: vi.fn(), sendEmail: vi.fn(), sendPush: vi.fn() }))
vi.mock('../src/db.js', () => ({ default: { query } }))
vi.mock('../src/email/send.js', () => ({ sendEmail }))
vi.mock('../src/notifications/push.js', () => ({ sendPushToUser: sendPush }))
import { notify } from '../src/notifications/transport.js'
beforeEach(() => { query.mockReset(); sendEmail.mockReset(); sendPush.mockReset() })
describe('organization HOLD at notification dispatch', () => {
  it('stops queued tenant work before mail, push, language lookups, or logs', async () => {
    query.mockResolvedValue({ rows: [] })
    const result = await notify({ organizationId: 41, userId: 9, recipient: 'synthetic@example.invalid', notification_type: 'weekly_serving_digest' })
    expect(result).toEqual({ status: 'skipped', reason: 'organization_held' })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('held_at IS NULL'), [41])
    expect(sendEmail).not.toHaveBeenCalled()
    expect(sendPush).not.toHaveBeenCalled()
  })
  it('rechecks HOLD after language resolution before provider dispatch', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 41 }] }).mockResolvedValueOnce({ rows: [] })
    const result = await notify({ organizationId: 41, recipient: 'synthetic@example.invalid', notification_type: 'weekly_serving_digest', lang: 'en' })
    expect(result.reason).toBe('organization_held')
    expect(sendEmail).not.toHaveBeenCalled()
    expect(sendPush).not.toHaveBeenCalled()
  })
})
