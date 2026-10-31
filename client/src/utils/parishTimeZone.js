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

// Friendly, localized label for a zone in the Org details dropdown
// (App Review R2 finding 10: raw IANA ids such as "America/Los_Angeles"
// read as code to a parish admin). The option VALUE stays the IANA
// name — only the visible text changes. Intl.DisplayNames has no
// timeZone type, so the generic long name comes from DateTimeFormat
// ("Pacific Time" / "hora del Pacífico"), followed by the city so two
// zones that share a generic name stay distinguishable. Any runtime
// failure falls back to the raw id, which is still a correct answer.
export function parishTimeZoneLabel(zone, locale = 'en-US') {
  if (typeof zone !== 'string' || !zone) return ''
  // Etc/GMT+5 is the inverse-sign POSIX name; its city part would read as
  // the opposite offset next to "GMT-05:00", so Etc zones show the name alone.
  const city = zone === 'UTC' || zone.startsWith('Etc/') ? '' : zone.split('/').slice(-1)[0].replace(/_/g, ' ')
  let name = ''
  // UTC's generic name is just "GMT"; its long name says what it is.
  const styles = zone === 'UTC' ? ['long', 'longGeneric'] : ['longGeneric', 'long']
  for (const style of styles) {
    try {
      const parts = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style }).formatToParts(new Date())
      name = parts.find(p => p.type === 'timeZoneName')?.value || ''
      if (name) break
    } catch { /* try the next style, then the raw id */ }
  }
  if (!name) return zone
  if (!city || name.includes(city)) return name
  return `${name} — ${city}`
}
