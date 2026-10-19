// The book, the sacristy sheet, and the Sunday Packet share this label.
// A non-fulfilled row that still carries a fulfilment stamp is not "fulfilled".

export const PREVIOUSLY_RECORDED_FULFILMENT = 'previously recorded fulfilment'

export function priorFulfilmentText(t, row, key) {
  if (!row || row.fulfilment_label !== PREVIOUSLY_RECORDED_FULFILMENT) return null
  return t(key)
}
