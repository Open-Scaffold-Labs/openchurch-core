// Which register entries were committed in this session and have not yet
// been seen in the register list. The drafts page marks a record when the
// commit returns 201; the register consumes the mark the first time it
// renders that row, so the entry settles onto the page like fresh ink
// once and never again (PHILOSOPHY §12: words first, motion supports
// them). In memory only: a reload or a second tab simply shows the row
// still, which is correct.

const pending = new Set()

export function markJustEntered(id) {
  if (id != null) pending.add(String(id))
}

// True exactly once per marked id.
export function consumeJustEntered(id) {
  const k = String(id)
  if (!pending.has(k)) return false
  pending.delete(k)
  return true
}
