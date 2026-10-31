// Format ochr_clients mailing_* columns for Contact display (SP-264).
// Same visibility as email/phone/company: any role that receives the
// member row sees the address when present. Returns null when empty.

export function formatMailingAddress(member) {
  if (!member || typeof member !== 'object') return null
  const line1 = typeof member.mailing_address_line1 === 'string' ? member.mailing_address_line1.trim() : ''
  const line2 = typeof member.mailing_address_line2 === 'string' ? member.mailing_address_line2.trim() : ''
  const city = typeof member.mailing_city === 'string' ? member.mailing_city.trim() : ''
  const state = typeof member.mailing_state === 'string' ? member.mailing_state.trim() : ''
  const postal = typeof member.mailing_postal === 'string' ? member.mailing_postal.trim() : ''
  const cityLine = [city, state].filter(Boolean).join(', ') + (postal ? (city || state ? ` ${postal}` : postal) : '')
  const parts = [line1, line2, cityLine.trim()].filter(Boolean)
  return parts.length ? parts.join('\n') : null
}

export function hasMailingAddress(member) {
  return Boolean(formatMailingAddress(member))
}
