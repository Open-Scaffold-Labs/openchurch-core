import { useState } from 'react'
import { X } from 'lucide-react'
import { initials } from '../utils/format'

// Multi-select member picker. Lifted out of Events.jsx so the Schedule
// page can reuse the same UX without two implementations drifting.
//
// Props:
//   members  — full list of org members (from /api/clients)
//   value    — array of selected member ids
//   onChange — (ids: number[]) => void
//   placeholder — optional search input placeholder
export default function MemberPicker({ members, value, onChange, placeholder = 'Search members to assign…' }) {
  const [q, setQ] = useState('')
  const selected = members.filter(m => value.some(id => String(id) === String(m.id)))
  const filtered = members.filter(m =>
    !value.some(id => String(id) === String(m.id)) &&
    (
      m.name.toLowerCase().includes(q.toLowerCase()) ||
      (m.role ?? '').toLowerCase().includes(q.toLowerCase())
    )
  )

  const add    = (id) => onChange([...value, id])
  const remove = (id) => onChange(value.filter(v => String(v) !== String(id)))

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map(m => (
            <span key={m.id} className="inline-flex items-center gap-1.5 text-xs font-medium pl-1 pr-2 py-0.5 rounded-full bg-church-50 dark:bg-ink-800 border border-church-200/60 dark:border-church-800/60 text-church-900 dark:text-parchment-100">
              <span className="w-5 h-5 rounded-full bg-church-900 dark:bg-church-700 flex items-center justify-center text-parchment-50 text-[9px] font-bold">
                {initials(m.name)}
              </span>
              {m.name}
              <button type="button" onClick={() => remove(m.id)} className="text-ink-400 hover:text-rose-500 transition-colors">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
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
            <li className="px-3 py-2 text-xs text-ink-500 dark:text-parchment-300/70">No matching members</li>
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
