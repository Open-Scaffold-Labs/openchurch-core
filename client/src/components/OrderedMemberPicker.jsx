import { useState } from 'react'
import { X, GripVertical, ArrowUp, ArrowDown } from 'lucide-react'
import { initials } from '../utils/format'

// Ordered, multi-select member picker for the rotation auto-fill UI
// (VS.1b). Differs from MemberPicker on two points:
//   - Order MATTERS — it drives the round-robin on the server, so
//     each picked member shows its position number and supports
//     reordering.
//   - Reorder UX is dual-mode: native HTML5 drag-and-drop on desktop
//     (the grip handle is hidden on small screens), and always-visible
//     up/down arrow buttons that work identically on mobile and
//     desktop. No reorder library; lucide icons we already ship.
//
// Props mirror MemberPicker for drop-in familiarity:
//   members  — full list of org members
//   value    — array of selected member ids, ORDERED
//   onChange — (orderedIds: number[]) => void
//   placeholder — search input placeholder
export default function OrderedMemberPicker({ members, value, onChange, placeholder = 'Search members to add to rotation…' }) {
  const [q, setQ] = useState('')
  const [dragFrom, setDragFrom] = useState(null)

  // Resolve ids → member objects in the user's chosen order, dropping
  // any id we can't find (a member deleted after being added, say).
  const selected = value
    .map(id => members.find(m => String(m.id) === String(id)))
    .filter(Boolean)

  const filtered = members.filter(m =>
    !value.some(id => String(id) === String(m.id)) &&
    (
      m.name.toLowerCase().includes(q.toLowerCase()) ||
      (m.role ?? '').toLowerCase().includes(q.toLowerCase())
    )
  )

  const add    = (id) => onChange([...value, id])
  const remove = (id) => onChange(value.filter(v => String(v) !== String(id)))
  const swap   = (i, j) => {
    if (j < 0 || j >= value.length) return
    const next = [...value]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  const onDragStart = (i) => () => setDragFrom(i)
  const onDragOver  = ()  => (e) => { e.preventDefault() }
  const onDrop      = (i) => (e) => {
    e.preventDefault()
    if (dragFrom === null || dragFrom === i) return
    const next = [...value]
    const [moved] = next.splice(dragFrom, 1)
    next.splice(i, 0, moved)
    onChange(next)
    setDragFrom(null)
  }

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <ol className="space-y-1.5">
          {selected.map((m, i) => (
            <li
              key={m.id}
              draggable
              onDragStart={onDragStart(i)}
              onDragOver={onDragOver(i)}
              onDrop={onDrop(i)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border ${
                dragFrom === i
                  ? 'border-church-500 bg-church-50/60 dark:bg-ink-800/60'
                  : 'border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800'
              }`}
            >
              <GripVertical
                size={14}
                className="text-ink-400 dark:text-parchment-300/40 cursor-grab shrink-0 hidden md:block"
              />
              <span className="w-5 h-5 rounded-full bg-church-900 dark:bg-church-700 flex items-center justify-center text-parchment-50 text-[10px] font-bold shrink-0">
                {i + 1}
              </span>
              <span className="w-6 h-6 rounded-full bg-church-900/80 dark:bg-church-700/80 flex items-center justify-center text-parchment-50 text-[9px] font-bold shrink-0">
                {initials(m.name)}
              </span>
              <span className="text-sm text-ink-900 dark:text-parchment-50 truncate flex-1">
                {m.name}
              </span>
              <button
                type="button"
                onClick={() => swap(i, i - 1)}
                disabled={i === 0}
                className="p-1 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Move up"
                aria-label="Move up"
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                onClick={() => swap(i, i + 1)}
                disabled={i === selected.length - 1}
                className="p-1 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Move down"
                aria-label="Move down"
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                onClick={() => remove(m.id)}
                className="p-1 text-ink-400 hover:text-rose-500 transition-colors"
                title="Remove"
                aria-label="Remove from rotation"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
      />
      {q && (
        <ul className="max-h-40 overflow-y-auto rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 divide-y divide-parchment-200/60 dark:divide-brass-900/25">
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-xs text-ink-500 dark:text-parchment-300/70">
              No matching members
            </li>
          )}
          {filtered.map(m => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => { add(m.id); setQ('') }}
                className="flex items-center gap-3 w-full px-3 py-2 text-left hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors"
              >
                <div className="w-6 h-6 rounded-full bg-church-900 dark:bg-church-700 flex items-center justify-center text-parchment-50 text-[9px] font-bold shrink-0">
                  {initials(m.name)}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">{m.name}</p>
                  <p className="text-xs text-ink-500 dark:text-parchment-300/70">{m.role ?? 'Member'}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
