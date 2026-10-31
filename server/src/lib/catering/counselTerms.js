// Legal terms for the parish hall agreement that counsel has not supplied.
//
// Every value below is null on purpose. A null term renders as a
// locale-matched "[COUNSEL TO SUPPLY]" / "[ASESORÍA LEGAL POR ENTREGAR]"
// placeholder in the agreement text and on the signing page. While any
// placeholder is in the text, the office cannot issue the signing link and
// nobody can sign it (catering.js send, hallSign.js sign). When counsel
// supplies the wording, it goes here, in both languages, and the gate opens
// on its own for agreements prepared after that. Agreements already prepared
// keep the text they were built with, so a draft made before the wording
// arrived has to be prepared again.
//
// Placeholder labels are not legal text. Do not invent counsel wording here.

export const COUNSEL_PLACEHOLDER = '[COUNSEL TO SUPPLY]'

export const COUNSEL_PLACEHOLDERS = Object.freeze({
  en: COUNSEL_PLACEHOLDER,
  // Localized marker only — not counsel-supplied legal text (Beacon B-H5).
  es: '[ASESORÍA LEGAL POR ENTREGAR]',
})

export const COUNSEL_TOPICS = Object.freeze({
  en: Object.freeze({
    cancellation: 'cancellation',
    refund: 'refund',
    liability: 'liability',
    insurance: 'insurance',
    effect: 'the legal effect of signing this page.',
  }),
  es: Object.freeze({
    cancellation: 'cancelación',
    refund: 'reembolso',
    liability: 'responsabilidad',
    insurance: 'seguro',
    effect: 'el efecto legal de firmar esta página.',
  }),
})

export const COUNSEL_TERMS = Object.freeze({
  en: Object.freeze({ cancellation: null, refund: null, liability: null, insurance: null, effect: null }),
  es: Object.freeze({ cancellation: null, refund: null, liability: null, insurance: null, effect: null }),
})

export const AGREEMENT_TOPICS = Object.freeze(['cancellation', 'refund', 'liability', 'insurance'])

// The supplied wording, or the placeholder for that topic.
export function counselText(locale, topic, terms = COUNSEL_TERMS) {
  const loc = locale === 'es' ? 'es' : 'en'
  const supplied = terms?.[loc]?.[topic]
  if (typeof supplied === 'string' && supplied.trim()) return supplied.trim()
  return `${COUNSEL_PLACEHOLDERS[loc]} ${COUNSEL_TOPICS[loc][topic] ?? topic}`
}

export function hasCounselPlaceholder(...texts) {
  const markers = Object.values(COUNSEL_PLACEHOLDERS)
  return texts.flat().some(text => typeof text === 'string' && markers.some(m => text.includes(m)))
}
