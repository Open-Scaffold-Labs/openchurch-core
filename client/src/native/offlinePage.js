// The iOS shell's load-failure page. The parish address is stamped in
// at sync time. The page itself decides offline versus unknown from
// navigator.onLine, and only claims the device reported no connection
// when that is true.

const MARKER = '__OC_RETRY__'

export function stampOfflinePage(html, retryUrl) {
  if (typeof html !== 'string' || !html.includes(MARKER)) {
    throw new Error('offline page is missing its retry marker')
  }
  const target = typeof retryUrl === 'string' && retryUrl.trim() ? retryUrl.trim() : 'index.html'
  if (/^\s*javascript:/i.test(target) || target.includes(MARKER)) {
    throw new Error('offline retry must be a page address')
  }
  return html.split(MARKER).join(target)
}
