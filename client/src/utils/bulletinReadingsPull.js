// SP-308: Bulletin "Pull readings" must pick a plan that actually has
// reading/psalm elements for the bulletin date. The service-plans list is
// ordered date DESC, id DESC, so plans.find(p => p.date === date) prefers a
// newer hymns-only plan over an older plan that has the readings (SP-301).
//
// Candidates for the date are tried in ascending id order (deterministic).
// Callers still load each candidate via the tenant-scoped
// GET /api/service-plans/:id — this helper only orders/filters the list.

/** @param {{ id: number|string, date: string }[]} plans */
export function plansForDateAscending(plans, date) {
  if (!Array.isArray(plans) || !date) return []
  return plans
    .filter(p => p && p.date === date)
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
}

/** @param {{ kind?: string, title?: string, reference?: string }[]} elements */
export function readingLinesFromElements(elements) {
  if (!Array.isArray(elements)) return []
  return elements
    .filter(e => e && (e.kind === 'reading' || e.kind === 'psalm'))
    .map(e => `${e.title}${e.reference ? ` — ${e.reference}` : ''}`)
}
