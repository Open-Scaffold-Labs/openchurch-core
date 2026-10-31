import { parseStoredDate, parseLocalDate } from './dates'

// Due copy for a task DATE. `now` is injectable so a US-evening test
// can prove the label is the stored day, not UTC midnight.
export function dueLabelFor(due_date, now = new Date()) {
  if (!due_date) return null
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const d = parseStoredDate(due_date) ?? parseLocalDate(due_date)
  if (!d || Number.isNaN(d.getTime())) return null
  d.setHours(0, 0, 0, 0)
  const diff = Math.round((d - today) / 86400000)
  if (diff < 0)  return { text: `${Math.abs(diff)}d overdue`, cls: 'text-rose-500 dark:text-rose-400', overdue: true }
  if (diff === 0) return { text: 'Due today',                  cls: 'text-amber-700 dark:text-amber-400', overdue: false }
  if (diff === 1) return { text: 'Due tomorrow',               cls: 'text-amber-700 dark:text-amber-300', overdue: false }
  return { text: `Due in ${diff}d`, cls: 'text-ink-500 dark:text-parchment-300/70', overdue: false }
}

// A task is overdue when it is still open and its stored civil day is
// before local today.
export function isTaskOverdue(task, now = new Date()) {
  if (!task || task.status === 'COMPLETED') return false
  return !!dueLabelFor(task.due_date, now)?.overdue
}
