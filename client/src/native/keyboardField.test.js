import { describe, expect, it } from 'vitest'
import { keyboardLiftTarget } from './keyboardField'

function control(tag, { type = 'text', disabled = false, readOnly = false, contenteditable = null } = {}) {
  const el = {
    disabled,
    readOnly,
    getAttribute(name) {
      if (name === 'type') return type
      if (name === 'contenteditable') return contenteditable
      return null
    },
    matches(sel) {
      if (tag === 'input') return sel.startsWith('input')
      if (tag === 'textarea') return sel.includes('textarea')
      if (tag === 'div') return sel.includes('contenteditable')
      return false
    },
    closest() {
      return null
    },
  }
  return el
}

describe('keyboard lift target', () => {
  it('lifts text fields and leaves buttons, files, and disabled fields', () => {
    expect(keyboardLiftTarget(control('input', { type: 'text' }))).not.toBeNull()
    expect(keyboardLiftTarget(control('textarea'))).not.toBeNull()
    expect(keyboardLiftTarget(control('input', { type: 'file' }))).toBeNull()
    expect(keyboardLiftTarget(control('input', { type: 'checkbox' }))).toBeNull()
    expect(keyboardLiftTarget(control('input', { type: 'text', disabled: true }))).toBeNull()
    expect(keyboardLiftTarget(control('input', { type: 'text', readOnly: true }))).toBeNull()
    expect(keyboardLiftTarget(null)).toBeNull()
  })

  it('lifts the field under the focused child', () => {
    const field = control('input', { type: 'email' })
    const child = { closest: () => field, matches: () => false }
    expect(keyboardLiftTarget(child)).toBe(field)
  })
})
