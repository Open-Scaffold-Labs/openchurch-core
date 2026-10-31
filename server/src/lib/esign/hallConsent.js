// Consent sentences for a parish hall agreement. Adapted from the
// consent shape in PR #347 (open-hoa esign core @ 8abfd78). The sentences
// are about this hall agreement. They do not claim a certified signature,
// and they do not speak for the sacramental register.
//
// This is not a PAdES or X.509 signature. Counsel review of ESIGN/UETA
// adequacy for a hall agreement is still open.

import { counselText, hasCounselPlaceholder } from '../catering/counselTerms.js'

export const CONSENT_VERSION = '2026-10-27-hall-counsel'

export const CONSENT_POINTS = {
  en: [
    { id: 'effect', text: counselText('en', 'effect') },
    { id: 'scope', text: 'This agreement covers this booking only. It does not enter the sacramental register.' },
    { id: 'money', text: 'The amounts listed are what the parish expects, and when. Nothing is charged from this page.' },
    { id: 'paper', text: 'You may ask the parish for a paper copy, or decline and sign on paper instead.' },
    { id: 'keep', text: 'This is not a certified electronic signature. The parish keeps the signed text and the time you signed.' },
  ],
  es: [
    { id: 'effect', text: counselText('es', 'effect') },
    { id: 'scope', text: 'Este acuerdo cubre solo esta reserva. No entra en el registro sacramental.' },
    { id: 'money', text: 'Las cantidades indicadas son lo que la parroquia espera, y cuándo. Desde esta página no se cobra nada.' },
    { id: 'paper', text: 'Puede pedir a la parroquia una copia en papel, o rehusar y firmar en papel.' },
    { id: 'keep', text: 'Esto no es una firma electrónica certificada. La parroquia conserva el texto firmado y la hora en que firmó.' },
  ],
}

export function consentPoints(locale) {
  return CONSENT_POINTS[locale === 'es' ? 'es' : 'en']
}

export function consentAccepted(locale, accepted) {
  if (!Array.isArray(accepted)) return false
  const need = new Set(consentPoints(locale).map(p => p.id))
  for (const id of accepted) {
    if (typeof id === 'string') need.delete(id)
  }
  return need.size === 0
}

// True while counsel's wording is missing from the agreement text or from
// the consent sentences the signer would tick, in either language. While
// it is true the office cannot issue the link and nobody can sign.
export function agreementCounselPending(contractEn, contractEs) {
  return hasCounselPlaceholder(
    contractEn, contractEs,
    CONSENT_POINTS.en.map(p => p.text), CONSENT_POINTS.es.map(p => p.text))
}
