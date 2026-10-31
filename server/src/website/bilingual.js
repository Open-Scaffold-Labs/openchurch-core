// Bilingual field helpers for the public site document.
// Content is authored as { en, es } objects (Dale Q7 / reference-public-site-patterns).

const MAX_FIELD = 4000
const MAX_SHORT = 240

export function isBilingualObject(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (typeof value.en === 'string' || typeof value.es === 'string')
  )
}

// Argus N460-4 / N452-3 parity — strip C0 controls + DEL from authored text.
function stripControls(s) {
  return String(s).replace(/[\u0000-\u001F\u007F]/g, '')
}

export function normalizeBilingual(value, { max = MAX_FIELD, fallbackEn = '' } = {}) {
  if (typeof value === 'string') {
    const en = stripControls(value).trim().slice(0, max)
    return { en, es: en }
  }
  if (!isBilingualObject(value)) {
    const en = stripControls(fallbackEn || '').slice(0, max)
    return { en, es: en }
  }
  const enRaw = typeof value.en === 'string' ? value.en : ''
  const esRaw = typeof value.es === 'string' ? value.es : enRaw
  const en = stripControls(enRaw).trim().slice(0, max)
  const es = (stripControls(esRaw).trim() || en).slice(0, max)
  return { en, es }
}

export function pickLocale(bilingual, locale = 'en') {
  if (!bilingual || typeof bilingual !== 'object') return ''
  const lang = locale === 'es' ? 'es' : 'en'
  const primary = bilingual[lang]
  if (typeof primary === 'string' && primary) return primary
  if (typeof bilingual.en === 'string') return bilingual.en
  if (typeof bilingual.es === 'string') return bilingual.es
  return ''
}

export { MAX_FIELD, MAX_SHORT }
