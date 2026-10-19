// What a parish's grant to its diocese releases (#214).
//
// A parish accepts a diocese with ONE control, ochr_diocese_affiliations.
// grant_level, and the words it reads when it chooses:
//   summary → period-level financial summaries, and the names and roles
//             of parish leadership
//   detail  → those, and account-level lines
// Neither says the chancery may have its clergy's phone numbers.
//
// So capabilities are an ALLOWLIST per grant level. A capability not listed
// is not granted; an unknown, ended or malformed grant releases nothing.
// Adding contact sharing is a parish-facing consent decision (a new grant
// level or a separate flag the parish sets, with copy it can read) — not a
// line changed here to make a screen fuller.
//
//   leadership.roster    names and roles of the parish's leadership
//   leadership.contacts  their email and phone. No existing grant level
//                        releases leadership contact details.
//   finance.accounts     per-account lines (mirrors withGrant in dioceseCare)
//
// A grant is only live on an ACTIVE affiliation. Invited (never accepted),
// suspended and ended affiliations release nothing: liveGrantLevel()
// returns null for them, and a null grant allows no capability.
//
// FUTURE, NOT IMPLEMENTED: share_leadership_contacts. If pastoral leads
// need clergy contact details, the parish grants it explicitly and
// separately from its financial grant level — a parish-side flag with its
// own plain-language copy, off by default, revocable. Releasing
// leadership.contacts would then require ALL of: an active affiliation,
// that parish consent, a diocesan user holding pastoral_lead, and a role
// that is not view-only. It must never be inferred from summary/detail.

const GRANT_CAPABILITIES = Object.freeze({
  summary: Object.freeze(['leadership.roster']),
  detail: Object.freeze(['leadership.roster', 'finance.accounts']),
})

// The only affiliation status that carries a grant. Invited (never
// accepted), suspended and ended are not in this list, so they release
// nothing. liveGrantLevel() and liveAffiliationSql() both read it — a
// care route must not keep its own copy of "active".
const LIVE_STATUSES = Object.freeze(['active'])

// The grant level in force for an affiliation row, or null when the
// affiliation is not live. Status first: a suspended covenant with a
// 'detail' grant releases exactly what an unknown grant does — nothing.
export function liveGrantLevel(affiliation) {
  if (!LIVE_STATUSES.includes(affiliation?.status)) return null
  const g = affiliation?.grant_level
  return typeof g === 'string' && Object.prototype.hasOwnProperty.call(GRANT_CAPABILITIES, g) ? g : null
}

// The same rule as liveGrantLevel, as a SQL fragment for a single-statement
// route. A separate round trip would let the affiliation change between the
// check and the read or write. `alias` is a programmer-supplied identifier,
// never request input. Grant levels and statuses come from this module.
export function liveAffiliationSql(alias = 'a') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('liveAffiliationSql: alias must be a SQL identifier')
  }
  const statuses = LIVE_STATUSES.map(s => `'${s}'`).join(', ')
  const levels = Object.keys(GRANT_CAPABILITIES).map(g => `'${g}'`).join(', ')
  return `${alias}.status IN (${statuses}) AND ${alias}.grant_level IN (${levels})`
}

export function grantAllows(grantLevel, capability) {
  if (typeof grantLevel !== 'string') return false
  if (!Object.prototype.hasOwnProperty.call(GRANT_CAPABILITIES, grantLevel)) return false
  return GRANT_CAPABILITIES[grantLevel].includes(capability)
}

// Contact PII needs ALL of: a grant that explicitly releases it, a diocesan
// user who holds pastoral_lead, and a role that is not view-only. `allows`
// is injectable only so the user-side conditions can be proven on their own
// while no grant level releases contacts.
export function mayReceiveLeadershipContacts(user, grantLevel, allows = grantAllows) {
  if (!allows(grantLevel, 'leadership.contacts')) return false
  if (user?.pastoral_lead !== true) return false
  if (user?.role === 'viewer') return false
  return true
}
