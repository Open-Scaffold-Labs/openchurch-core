// SP-054: "Welcome aboard. Your first member is on the roster." appeared
// in a fresh browser with 12 members already present. The toast is per
// browser; "first" has to come from the parish's own count.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { celebrateFirstAction } from './firstActionToast'

const toast = () => ({ success: vi.fn() })
beforeEach(() => localStorage.clear())

describe('celebrateFirstAction', () => {
  it('fires once when the parish had none before the create', () => {
    const t = toast()
    expect(celebrateFirstAction('member', t, 0)).toBe(true)
    expect(t.success).toHaveBeenCalledWith('Welcome aboard. Your first member is on the roster.')
    expect(celebrateFirstAction('member', t, 0)).toBe(false)
    expect(t.success).toHaveBeenCalledTimes(1)
  })

  it('does not call the 13th member the first, and retires the toast for this browser', () => {
    const t = toast()
    expect(celebrateFirstAction('member', t, 12)).toBe(false)
    expect(t.success).not.toHaveBeenCalled()
    expect(celebrateFirstAction('member', t, 0)).toBe(false)
    expect(t.success).not.toHaveBeenCalled()
  })

  it('accepts a COUNT(*) numeric string', () => {
    const many = toast()
    expect(celebrateFirstAction('task', many, '7')).toBe(false)
    expect(many.success).not.toHaveBeenCalled()
    localStorage.clear()
    const none = toast()
    expect(celebrateFirstAction('task', none, '0')).toBe(true)
  })

  for (const [label, unknown] of [['missing', undefined], ['null (failed read)', null], ['NaN', NaN], ['blank string', ''], ['negative', -1], ['object', {}]]) {
    it(`an unknown prior count (${label}) says nothing and decides nothing`, () => {
      const t = toast()
      expect(celebrateFirstAction('event', t, unknown)).toBe(false)
      expect(t.success).not.toHaveBeenCalled()
      // Still able to celebrate once the count is known to be zero.
      expect(celebrateFirstAction('event', t, 0)).toBe(true)
    })
  }
})
