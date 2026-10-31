import { describe, expect, it } from 'vitest'
import { consumeJustEntered, markJustEntered } from './justEntered'

describe('justEntered', () => {
  it('reports a committed record exactly once', () => {
    markJustEntered(41)
    expect(consumeJustEntered('41')).toBe(true)
    expect(consumeJustEntered(41)).toBe(false)
  })
  it('ignores ids that were never marked, and a missing id', () => {
    markJustEntered(undefined)
    expect(consumeJustEntered(7)).toBe(false)
    expect(consumeJustEntered('undefined')).toBe(false)
  })
})
