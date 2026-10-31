// Liturgical feast labels from /api/liturgical/range.
// null litByDate means the range was unread (UNKNOWN), not an empty week.

export function feastLabelForDay(date, litByDate) {
  const day = date == null ? '' : String(date).slice(0, 10)
  if (!day || litByDate == null) return ''
  const fromLit = litByDate?.[day]?.feast_name
  return typeof fromLit === 'string' && fromLit.trim() ? fromLit.trim() : ''
}
