// One alias table for the Org details dropdown and the server write
// path. A name the list offers is a name settings can store. The
// server re-exports this module. It has no database import, so the
// client bundle can use it.

// Browsers and older ICU data still report these. Slim tzdata (this
// host and CI) does not, and `AT TIME ZONE` then errors. The modern
// name is the IANA backward link. US/* and the city aliases from the
// Argus probe are included. Kept to names Intl still emits.
export const PARISH_TIMEZONE_ALIASES = Object.freeze({
  'Asia/Calcutta': 'Asia/Kolkata',
  'Europe/Kiev': 'Europe/Kyiv',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Africa/Asmera': 'Africa/Asmara',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
  'US/Pacific': 'America/Los_Angeles',
  'US/Pacific-New': 'America/Los_Angeles',
  'US/Eastern': 'America/New_York',
  'US/Central': 'America/Chicago',
  'US/Mountain': 'America/Denver',
  'US/Alaska': 'America/Anchorage',
  'US/Hawaii': 'Pacific/Honolulu',
  'US/Arizona': 'America/Phoenix',
  'US/Aleutian': 'America/Adak',
  'US/East-Indiana': 'America/Indiana/Indianapolis',
  'US/Indiana-Starke': 'America/Indiana/Knox',
  'US/Michigan': 'America/Detroit',
  'US/Samoa': 'Pacific/Pago_Pago',
})

// +05:00 and +0500. Postgres reads a bare offset with the opposite
// sign of ISO; +0500 is an error. POSIX forms (EST5EDT, <+05>5) are
// the same family. Etc/GMT+5 contains a slash and is a real zone name.
const BARE_OFFSET = /^[+-]\d{2}(?::?\d{2}){0,2}$/

function rejectedZoneSyntax(tz) {
  if (BARE_OFFSET.test(tz)) return true
  if (tz.startsWith('<')) return true
  if (!tz.includes('/') && /\d/.test(tz)) return true
  return false
}

// Trim, map a known legacy alias, and refuse offsets and POSIX strings.
// Null means "not a zone we will store" (missing, blank, or rejected).
// Does not consult Postgres.
export function canonicalParishTimeZone(raw) {
  if (typeof raw !== 'string') return null
  const tz = raw.trim()
  if (!tz || rejectedZoneSyntax(tz)) return null
  const mapped = PARISH_TIMEZONE_ALIASES[tz] ?? tz
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: mapped })
    return mapped
  } catch {
    return null
  }
}

// Dropdown values. Legacy names are rewritten to the modern one so the
// option value is what a save stores. Names the syntax guard rejects
// are left out.
export function offeredParishTimeZones(names) {
  const out = []
  for (const name of names) {
    const zone = canonicalParishTimeZone(name)
    if (zone) out.push(zone)
  }
  return Array.from(new Set(out))
}
