// Parents before children.
//
// Split out of offsite-restore-drill.mjs so the suite can hold it,
// because getting this wrong is silent: the restore still succeeds, it
// just takes six times longer while every child row is inserted twice.
// Nothing fails, so nothing tells you — which is why it survived until
// somebody drilled a parish big enough for seconds to become minutes.
//
// Takes the table list and the foreign-key pairs the target database
// reports, and returns an insert order. Self-references are ignored
// (ordering cannot help a row that points at its own table), and a cycle
// leaves its members at the end for the retry pass to settle.
export function dependencyOrder(tables, fkPairs) {
  const parentsOf = {}
  for (const { child, parent } of fkPairs) {
    if (child === parent) continue
    ;(parentsOf[child] ||= new Set()).add(parent)
  }
  const present = new Set(tables)
  const done = new Set(), out = []
  let progress = true
  while (out.length < tables.length && progress) {
    progress = false
    for (const t of tables) {
      if (done.has(t)) continue
      const waiting = [...(parentsOf[t] || [])].some(p => present.has(p) && !done.has(p))
      if (waiting) continue
      out.push(t); done.add(t); progress = true
    }
  }
  return [...out, ...tables.filter(t => !done.has(t))]
}
