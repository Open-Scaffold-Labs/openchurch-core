import { useEffect, useState, useCallback } from 'react'
import { Check, X, Minus, Users, Loader2 } from 'lucide-react'
import { apiUrl } from '../api'
import { useToast } from './ToastProvider'
import SaveButton, { useSaveStatus } from './SaveButton'

// Attendance section in the Event edit modal (Sprint T / T.2). Only
// renders when editing an existing event (creates have no roster yet).
//
// State model:
//   marks: { [member_id]: 'present' | 'absent' | 'excused' | null }
// User clicks change `marks` locally; the explicit Save button does a
// single bulk POST of the current state. This avoids per-click round-
// trips and gives the user a clear 'did I save?' answer via the V3
// SaveButton checkmark.
//
// 'Mark all present' is the common case for a regular Sunday — one
// click and the whole roster is marked, then the user only flips
// the few absentees.

// These three chips were the worst contrast in the app and nobody had
// measured them: white on emerald-500 is 2.54:1, less than half the AA
// floor of 4.5:1, on a control that is clicked dozens of times every
// Sunday. Rose-600 was 4.70:1 — passing by a hair with pure white, and it
// would have FAILED at 4.43:1 the moment the text-white sweep landed. A
// mechanical find-and-replace would have quietly broken it.
//
// So the chips move into the warm palette and get measured, not guessed
// (all against parchment-50): brass-700 6.83:1 for present — brass is the
// gilt, affirmative voice, same as a fully-met pledge; amber-800 6.69:1
// for excused, the middle state; rose-800 7.56:1 for absent. Same
// good/middle/bad reading, no traffic light, no failures.
const STATUSES = [
  { key: 'present', label: 'Present', icon: Check,  className: 'bg-brass-700 text-parchment-50 border-brass-700' },
  { key: 'absent',  label: 'Absent',  icon: X,      className: 'bg-rose-800 text-parchment-50 border-rose-800' },
  { key: 'excused', label: 'Excused', icon: Minus,  className: 'bg-amber-800 text-parchment-50 border-amber-800' },
]

const STATUS_LABEL = {
  present: 'present',
  absent:  'absent',
  excused: 'excused',
}

export default function AttendanceSection({ eventId }) {
  const toast = useToast()
  const [roster, setRoster] = useState(null)   // [{ member_id, member_name, member_email, status }, …]
  const [marks, setMarks]   = useState({})      // local mutations keyed by member_id
  const [loading, setLoad]  = useState(true)
  const [err, setErr]       = useState('')

  const load = useCallback(() => {
    if (!eventId) return
    setLoad(true)
    setErr('')
    fetch(apiUrl(`/api/events/${eventId}/attendance`))
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Failed (${r.status})`)))
      .then(d => {
        setRoster(d.roster ?? [])
        // Seed local marks from the server response — anything
        // un-marked stays absent from the map (rendered as 'no mark').
        const seed = {}
        for (const r of d.roster ?? []) {
          if (r.status) seed[r.member_id] = r.status
        }
        setMarks(seed)
      })
      .catch(e => setErr(e.message))
      .finally(() => setLoad(false))
  }, [eventId])

  useEffect(() => { load() }, [load])

  // Bulk save wrapped in useSaveStatus so the V3 SaveButton transitions
  // idle → saving → 'Saved' checkmark on success.
  const { status: saveStatus, run: save } = useSaveStatus(async () => {
    const payload = {
      marks: Object.entries(marks).map(([member_id, status]) => ({
        member_id: Number(member_id),
        status,
      })),
    }
    if (payload.marks.length === 0) {
      throw new Error('Mark at least one member before saving.')
    }
    const res = await fetch(apiUrl(`/api/events/${eventId}/attendance`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Save failed (${res.status})`)
    }
    return res.json()
  }, {
    onSuccess: () => {
      // Refresh from the server so the summary counts stay honest
      // even when a teammate marked attendance concurrently. Cheap —
      // GET is private-cached 10s.
      load()
    },
  })

  // No assigned members → nothing to mark. Hide the section entirely
  // so an empty 'attendance' card doesn't sit there confusingly.
  if (!loading && roster && roster.length === 0) {
    return null
  }

  // Local summary for the header (reflects the in-flight state, not
  // the server's last-saved view).
  const summary = (() => {
    const out = { present: 0, absent: 0, excused: 0, unmarked: 0 }
    if (!roster) return out
    for (const r of roster) {
      const m = marks[r.member_id]
      if (m === 'present')     out.present++
      else if (m === 'absent') out.absent++
      else if (m === 'excused') out.excused++
      else out.unmarked++
    }
    return out
  })()

  function setOne(memberId, status) {
    setMarks(prev => {
      const next = { ...prev }
      // Re-clicking the same status clears the mark — gives the user
      // an 'undo' affordance without a separate button.
      if (next[memberId] === status) delete next[memberId]
      else next[memberId] = status
      return next
    })
  }

  function markAllPresent() {
    if (!roster) return
    const next = {}
    for (const r of roster) next[r.member_id] = 'present'
    setMarks(next)
  }

  function clearAll() {
    setMarks({})
  }

  return (
    <div className="pt-2 border-t border-parchment-300/60 dark:border-brass-900/30">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <Users size={13} className="text-church-700 dark:text-brass-300" />
          <h3 className="text-xs font-semibold text-ink-700 dark:text-parchment-200">Attendance</h3>
          {!loading && roster?.length > 0 && (
            <span className="text-[11px] text-ink-500 dark:text-parchment-300/70">
              · {summary.present + summary.absent + summary.excused} of {roster.length} marked
            </span>
          )}
        </div>
        {!loading && roster?.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={markAllPresent}
              className="text-[11px] font-semibold text-church-700 dark:text-brass-300 hover:underline"
            >
              Mark all present
            </button>
            <span className="text-ink-300 dark:text-parchment-400/40">·</span>
            <button
              type="button"
              onClick={clearAll}
              className="text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 hover:text-ink-700 dark:hover:text-parchment-100"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-church-700 dark:text-brass-300" />
        </div>
      ) : err ? (
        <p className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2">
          {err}
        </p>
      ) : (
        <>
          <ul className="space-y-1.5 mb-3">
            {roster.map(r => {
              const current = marks[r.member_id]
              return (
                <li
                  key={r.member_id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-parchment-100 dark:bg-ink-800/60"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">
                      {r.member_name}
                    </p>
                    {current && (
                      <p className="text-[10px] text-ink-500 dark:text-parchment-300/70 capitalize">
                        {STATUS_LABEL[current]}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {STATUSES.map(s => {
                      const active = current === s.key
                      return (
                        <button
                          key={s.key}
                          type="button"
                          onClick={() => setOne(r.member_id, s.key)}
                          aria-label={`${s.label} ${r.member_name}`}
                          title={s.label}
                          className={`inline-flex items-center justify-center w-7 h-7 rounded-md border transition-colors ${
                            active
                              ? s.className
                              : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:bg-parchment-200 dark:hover:bg-ink-800'
                          }`}
                        >
                          <s.icon size={13} />
                        </button>
                      )
                    })}
                  </div>
                </li>
              )
            })}
          </ul>

          {/* Summary chips + Save */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2 text-[11px]">
              {/* Brass, to match the Present chip above. Leaving this one
                  emerald would have been the giveaway that the chips were
                  recoloured and the tally was not. */}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brass-50 dark:bg-brass-900/20 text-brass-700 dark:text-brass-300">
                <Check size={10} /> {summary.present}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300">
                <X size={10} /> {summary.absent}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300">
                <Minus size={10} /> {summary.excused}
              </span>
              {summary.unmarked > 0 && (
                <span className="text-ink-500 dark:text-parchment-300/70">· {summary.unmarked} unmarked</span>
              )}
            </div>
            <SaveButton
              status={saveStatus}
              onClick={() => save().catch(err => toast.error(err.message))}
              type="button"
              disabled={Object.keys(marks).length === 0}
              className="text-xs px-3 py-2"
            >
              Save attendance
            </SaveButton>
          </div>
        </>
      )}
    </div>
  )
}
