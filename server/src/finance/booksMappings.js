// OC-BOOKS-1 category defaults (SP-214).
//
// F2 and F3 on issue #342 are still open. The reversible choices here:
//   · second collections are a liability (2320), which a later diocesan
//     mapping can supersede;
//   · the defaults start on the cutover date stored by migration 132 and
//     do not reach back, so a gift dated earlier keeps its account;
//   · 'special offering' is an explicit 4420 row, not a silent fallback.
// building fund and missions are intentionally absent: staff pick a fund.
// A fund the parish keeps for a donor purpose is 4450, and a parish
// cannot point a fund or a category there when that lowers the base.

// [source_key, account_code]. Keys match the category strings the parish
// app already stores (client Donations.jsx and the sample seed).
export const TEMPLATE_CATEGORY_DEFAULTS = Object.freeze([
  ['offering', '4110'],
  ['offertory', '4110'],
  ['tithe', '4110'],
  ['special collection', '2320'],
  ['special offering', '4420'],
])

// 4510 and 5520 stay on the chart for history. New mappings use 2320.
export const HISTORY_ONLY_ACCOUNT_CODES = new Set(['4510', '5520'])

export function isAssessableRevenue(code, byCode) {
  if (!code) return false
  const row = byCode.get(code)
  if (!row || row.acct_type !== 'revenue') return false
  return row.assessable === true
}

// True when the account in effect on the mapping's start date is assessable
// revenue and the replacement is not. Unmapped money is not in the base, so
// giving it an assessable account does not shrink anything.
export function mappingShrinksAssessableBase(previousCode, nextCode, byCode) {
  if (!isAssessableRevenue(previousCode, byCode)) return false
  return !isAssessableRevenue(nextCode, byCode)
}

// Restricted funds (BOOKS-1.1) may map only to these codes. Pass-through /
// restricted revenue; assessable revenue is refused. Chancery writes the
// mapping (set_by='diocese'); the parish gate still refuses a base-lowering
// write (D2).
export const RESTRICTED_FUND_ACCOUNT_CODES = Object.freeze(new Set(['4450', '2320']))

export function isRestrictedFundAccount(code) {
  return RESTRICTED_FUND_ACCOUNT_CODES.has(code)
}
