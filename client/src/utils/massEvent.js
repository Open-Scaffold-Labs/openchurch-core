// Which calendar rows can take an intention. Kept in step with
// server/src/routes/massIntentions.js NON_MASS_EVENT_TYPES.
//
// The Schedule form writes three types (TYPE_META):
//   service — the default pill, listed first
//   event   — the Event pill, and what an omitted type is stored as
//   meeting — the only clearly non-liturgical type that form writes.
//             Refused in any case, including surrounding spaces.
//
// Production's mix is UNKNOWN. A new link is refused only for a type
// known not to be a Mass. service, mass, event, liturgy, a blank type,
// and NULL stay assignable, as does any other word we cannot rule out.

export const NON_MASS_CALENDAR_TYPES = new Set(['meeting'])
export const PRIMARY_MASS_TYPES = new Set(['service', 'mass'])

function storedType(event) {
  if (event?.type == null) return null
  const type = String(event.type).trim().toLowerCase()
  return type === '' ? null : type
}

export function isMassCalendarEvent(event) {
  if (!event) return false
  const type = storedType(event)
  if (type == null) return true
  return !NON_MASS_CALENDAR_TYPES.has(type)
}

export function isPrimaryMassCalendarEvent(event) {
  const type = storedType(event)
  return type != null && PRIMARY_MASS_TYPES.has(type)
}

// service and mass first. Every other assignable row is secondary,
// so a Mass stored as event or with no type can still be picked.
export function groupAssignableEntries(events) {
  const primary = []
  const other = []
  for (const event of Array.isArray(events) ? events : []) {
    if (!isMassCalendarEvent(event)) continue
    if (isPrimaryMassCalendarEvent(event)) primary.push(event)
    else other.push(event)
  }
  return { primary, other }
}
