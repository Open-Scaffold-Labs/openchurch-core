const base = import.meta.env.VITE_API_URL || ''

export function apiUrl(path) {
  return `${base}${path}`
}
