// Shared formatting helpers used across pages.

// Up to two initials from a name, uppercased. Handles missing names and
// extra whitespace safely so avatar fallbacks never crash.
export function initials(name = '') {
  return (name || '')
    .split(' ')
    .map(n => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}
