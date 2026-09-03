import { useState } from 'react'
import { X } from 'lucide-react'

// Quiet orientation (PILOT.4).
//
// Deliberately NOT a setup checklist. There is no progress bar, no counter,
// no tick marks, no "3 of 5 complete", and no celebration when the last one
// is done — because all of those turn orientation into an obligation, and
// an obligation is the opposite of what this product is for. A diocese that
// opens this twice a month is a success; one that feels chased is not.
//
// It says what the five screens are for, once, and then goes away for good
// the moment it is dismissed. Nothing brings it back and nothing asks
// again.

const KEY = 'ochr_diocese_first_use_dismissed'

const STEPS = [
  ['Parish Care', 'Where the office works from. Who needs attention, why, and what the next step might be.'],
  ['A parish', 'Open one for its context — what has been happening, what was agreed, and who to ask.'],
  ['A follow-up', 'Note something worth coming back to. Nothing chases you, and “let it go” is a real answer.'],
  ['A report', 'Read a submitted report with the parish and record the conversation, not a verdict.'],
  ['A care brief', 'Print a page to carry into a visitation. It is the thing that leaves the building.'],
]

export default function FirstUse() {
  const [gone, setGone] = useState(() => {
    try { return localStorage.getItem(KEY) === '1' } catch { return true }
  })
  if (gone) return null

  const dismiss = () => {
    try { localStorage.setItem(KEY, '1') } catch { /* private mode; it just returns next time */ }
    setGone(true)
  }

  return (
    <aside className="print:hidden mb-7 rounded-xl border border-parchment-300/70 bg-parchment-50 p-5 relative">
      <button type="button" onClick={dismiss} aria-label="Dismiss this orientation"
        className="tap-reach absolute top-3 right-3 text-ink-400 hover:text-ink-700">
        <X size={15} />
      </button>

      <p className="font-serif text-lg font-bold text-church-700 mb-1">What is here</p>
      <p className="text-[12.5px] text-ink-500 mb-4 max-w-2xl leading-relaxed">
        Five screens, in the order they are usually used. Nothing needs setting up first.
      </p>

      <ol className="space-y-2.5 max-w-2xl">
        {STEPS.map(([title, body], i) => (
          <li key={title} className="flex gap-3">
            <span className="text-[11px] font-semibold text-brass-600 tabular-nums mt-0.5 shrink-0"
              aria-hidden="true">{i + 1}</span>
            <span className="text-[13px] text-ink-700 leading-snug">
              <span className="font-semibold text-ink-900">{title}.</span> {body}
            </span>
          </li>
        ))}
      </ol>

      <button type="button" onClick={dismiss}
        className="mt-4 text-[12.5px] text-church-700 hover:underline">
        Got it — don’t show this again
      </button>
    </aside>
  )
}
