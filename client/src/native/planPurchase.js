// Plan purchase inside the iOS shell. Guideline 3.1 treats an upgrade
// button for the software itself as a digital purchase. The shell shows
// the current plan and does not start checkout or the billing portal.
// Parish giving is a different path: the gift is completed on the
// processor's own page, outside this app.
//
// C2 (Dale, #342 comment 6429592110): the iPhone and iPad app is a free
// companion app (Guideline 3.1.3(b)). Inside the shell there is no SaaS
// price, no plan comparison, no upgrade prompt, no checkout or portal
// link, and no "pricing will be announced" note. The Billing sidebar
// link, the Billing help module and the cost FAQ are hidden too. The web
// is unchanged: every helper below returns the web answer when native is
// not exactly true.

const EN = {
  shellTitle: 'Parish account',
  plan: 'The OpenChurch app for iPhone and iPad is free. Nothing is sold or charged in this app.',
  giftOpened: 'The gift continues on a page outside this app. If you finished, you do not need to send it again from here.',
  giftClosed: 'We could not confirm that the checkout page opened. This screen does not know whether the gift went through, so it will not send it again.',
  giftReopen: 'Open checkout again',
  giftStartOver: 'Start a new gift',
}

const ES = {
  shellTitle: 'Cuenta de la parroquia',
  plan: 'La aplicación OpenChurch para iPhone y iPad es gratuita. En esta aplicación no se vende ni se cobra nada.',
  giftOpened: 'El donativo continúa en una página fuera de esta aplicación. Si terminó, no hace falta enviarlo otra vez desde aquí.',
  giftClosed: 'No pudimos confirmar que la página de pago se abriera. Esta pantalla no sabe si el donativo se realizó, así que no lo enviará otra vez.',
  giftReopen: 'Abrir el pago otra vez',
  giftStartOver: 'Comenzar otro donativo',
}

function copy(locale) {
  if (typeof locale === 'string' && locale.toLowerCase().startsWith('es')) return ES
  return EN
}

export function planPurchaseOfferedInShell(native) {
  return native !== true
}

// Sidebar paths, help module ids and FAQ questions that only exist to
// describe the SaaS plan. Hidden inside the shell.
export const SHELL_PRICING_PATHS = ['/billing']
export const PRICING_HELP_MODULE_IDS = new Set(['billing'])
export const PRICING_FAQ_QUESTION = 'What does OpenChurch cost?'

export function pricingShownInShell(native) {
  return native !== true
}

function samePath(a, b) {
  const norm = (p) => (String(p || '/').replace(/\/+$/, '') || '/').toLowerCase()
  return norm(a) === norm(b)
}

export function isPricingPath(pathname) {
  return SHELL_PRICING_PATHS.some((p) => samePath(p, pathname))
}

export function navItemOfferedInShell(item, native) {
  if (!item) return false
  if (native !== true) return true
  return !isPricingPath(item.to)
}

export function helpModuleOfferedInShell(id, native) {
  if (native !== true) return true
  return !PRICING_HELP_MODULE_IDS.has(id)
}

export function helpFaqOfferedInShell(question, native) {
  if (native !== true) return true
  return question !== PRICING_FAQ_QUESTION
}

export function helpSearchRowOfferedInShell(row, native) {
  if (!row) return false
  if (native !== true) return true
  if (PRICING_HELP_MODULE_IDS.has(row.id)) return false
  if (row.kind === 'faq' && row.title === PRICING_FAQ_QUESTION) return false
  return true
}

export function shellAccountTitle(locale) {
  return copy(locale).shellTitle
}

export function shellPlanNote(locale) {
  return copy(locale).plan
}

export function giftOpenedOutsideNote(locale) {
  return copy(locale).giftOpened
}

export function giftPageDidNotOpenNote(locale) {
  return copy(locale).giftClosed
}

export function giftStartOverLabel(locale) {
  return copy(locale).giftStartOver
}

export function giftReopenLabel(locale) {
  return copy(locale).giftReopen
}
