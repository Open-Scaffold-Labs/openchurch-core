// SP-158 — the traditional † marks an intention for the departed only.
// Same rule as the book list, the sacristy sheet and the Sunday packet:
// the stored text starts with † or a hand-typed "+". Any other intention
// (thanksgiving, a living person's needs) shows no dagger.
const MARK = /^\s*[†+]\s*/

export function intentionForDeparted(text) {
  return /^\s*[†+]/.test(text || '')
}

// { departed, text } with the mark removed from text, so callers can render
// one normalized † (or none) themselves.
export function splitDeathMark(text) {
  const raw = text || ''
  const departed = intentionForDeparted(raw)
  return { departed, text: departed ? raw.replace(MARK, '') : raw }
}
