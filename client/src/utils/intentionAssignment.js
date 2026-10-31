import { PREVIOUSLY_RECORDED_FULFILMENT } from './priorFulfilment'

// SP-071: an intention still waiting for a Mass. Only the known open/scheduled
// statuses qualify; a previously recorded fulfilment keeps its historical label.
const NEEDS_MASS_STATUSES = new Set(['open', 'scheduled'])

export function isUnassigned(r) {
  if (!r || !NEEDS_MASS_STATUSES.has(r.status)) return false
  if (r.fulfilment_label === PREVIOUSLY_RECORDED_FULFILMENT) return false
  return r.calendar_event_id == null
}
