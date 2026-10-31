// Open beta pricing switch (José, 2026-10-25). OpenChurch is in an open
// beta and pricing is not decided yet, so every displayed price, tier
// comparison and upgrade or checkout call to action stays hidden while
// PRICING_VISIBLE is false. Plan definitions (server/src/billing/plans.js),
// entitlements and the billing server routes are untouched; flipping this
// to true restores the previous Billing page exactly.
//
// Copy lives here rather than in i18n/strings.js so this switch does not
// collide with the open PRs that edit that file.

export const PRICING_VISIBLE = false

const EN = {
  beta: 'OpenChurch is free during the open beta. Any dollar figures in a nonprofit fee or pricing guide are illustrative only (status: illustrative_unapproved) and are not board-approved — treat them as UNKNOWN until Dale and José lock parish pricing. No Connect account UI ships yet.',
  title: 'Open beta',
  subtitle: 'Your parish account during the open beta. Online giving stays on hold; Connect is not activated here.',
}

const ES = {
  beta: 'OpenChurch es gratuito durante la beta abierta. Cualquier cifra en una guía de tarifas o precios es solo ilustrativa (estado: illustrative_unapproved) y no está aprobada por la junta — trátela como DESCONOCIDA hasta que Dale y José fijen los precios parroquiales. Aún no hay pantalla para conectar Stripe Connect.',
  title: 'Beta abierta',
  subtitle: 'La cuenta de su parroquia durante la beta abierta. Las donaciones en línea siguen en pausa; Connect no se activa aquí.',
}

function copy(locale) {
  if (typeof locale === 'string' && locale.toLowerCase().startsWith('es')) return ES
  return EN
}

export function betaPricingNote(locale) {
  return copy(locale).beta
}

export function betaPricingTitle(locale) {
  return copy(locale).title
}

export function betaBillingSubtitle(locale) {
  return copy(locale).subtitle
}
