// Trial-balance import checks (OC-BOOKS-1 S1b).
//
// The ledger stores a natural sign: asset and expense debit-positive,
// liability, net assets and revenue credit-positive. A trial balance
// arrives as debit and credit columns (or as an already-natural amount)
// and is stored only when those sides are equal. Opening Balance Equity
// must be zero; a non-zero plug is refused rather than posted.

import crypto from 'node:crypto'

const AMOUNT_RE = /^-?\d{1,9}(\.\d{1,2})?$/
const CREDIT_NORMAL = new Set(['liability', 'net_asset', 'revenue'])
const MAX_CENTS = 9_999_999_900

export function dollarsToCents(raw) {
  if (raw == null) return null
  const t = String(raw).trim().replace(/,/g, '')
  if (!t || !AMOUNT_RE.test(t)) return null
  const neg = t.startsWith('-')
  const [whole, frac = ''] = t.slice(neg ? 1 : 0).split('.')
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2))
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null
  return neg ? -cents : cents
}

export function centsToDollarString(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function isCreditNormal(acctType) {
  return CREDIT_NORMAL.has(acctType)
}

// Debit-positive net, then flipped for credit-normal accounts so a credit
// balance is stored as a positive natural amount.
export function naturalCentsFromSides(acctType, debitCents, creditCents) {
  const netDebit = debitCents - creditCents
  return isCreditNormal(acctType) ? -netDebit : netDebit
}

export function sidesFromNatural(acctType, naturalCents) {
  const magnitude = Math.abs(naturalCents)
  if (naturalCents === 0) return { debitCents: 0, creditCents: 0 }
  const onCredit = isCreditNormal(acctType) ? naturalCents > 0 : naturalCents < 0
  return onCredit
    ? { debitCents: 0, creditCents: magnitude }
    : { debitCents: magnitude, creditCents: 0 }
}

export function trialBalanceSides(lines) {
  let debitCents = 0
  let creditCents = 0
  for (const line of lines) {
    debitCents += line.debitCents
    creditCents += line.creditCents
  }
  return { debitCents, creditCents, balanced: debitCents === creditCents }
}

export function isOpeningBalanceEquityName(name) {
  return typeof name === 'string' && /^\s*opening balance equity\s*$/i.test(name)
}

// The replay key for an import. Built from the parsed lines, sorted, so a
// re-export of the same trial balance with its rows in another order, or
// with debit/credit columns instead of natural amounts, is the same import.
export function trialBalanceIdempotencyKey(asOf, lines) {
  const canonical = lines
    .map(l => `${l.code}|${l.debitCents}|${l.creditCents}|${l.memo ?? ''}`)
    .sort()
    .join('\n')
  return crypto.createHash('sha256').update(`${asOf}\n${canonical}`).digest('hex')
}
