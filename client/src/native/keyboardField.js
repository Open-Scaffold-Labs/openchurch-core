// A focused control the keyboard can cover. Buttons, files, and hidden
// fields are not scrolled. The shell calls this only inside the iOS app.

const SKIPPED_TYPES = new Set([
  'hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'image',
])

const FIELD = 'input, textarea, select, [contenteditable="true"]'

export function keyboardLiftTarget(node) {
  if (!node || typeof node.closest !== 'function') return null
  const field = typeof node.matches === 'function' && node.matches(FIELD)
    ? node
    : node.closest(FIELD)
  if (!field) return null
  if (typeof field.matches === 'function' && field.matches('input')) {
    const type = String(field.getAttribute?.('type') || 'text').toLowerCase()
    if (SKIPPED_TYPES.has(type)) return null
  }
  if (field.disabled || field.readOnly) return null
  const editable = field.getAttribute?.('contenteditable')
  if (typeof editable === 'string' && editable.toLowerCase() === 'false') return null
  return field
}
