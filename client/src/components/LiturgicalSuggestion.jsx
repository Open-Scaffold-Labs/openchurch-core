import { useEffect, useState } from 'react'
import { Cross } from 'lucide-react'
import { apiUrl } from '../api'
import { LIT_COLOR_DOT, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'
import { useLocale } from '../i18n'

// Liturgical context chip shown above the AI Studio prompt textarea.
// Surfaces the upcoming Sunday's season + feast so a pastor doesn't
// have to type the date or look up the calendar before drafting.
//
// Click behavior — quiet, opt-in:
//   - When the prompt is empty: clicking the chip seeds the textarea
//     with a sentence-starter tailored to the selected content type
//     ("A Pentecost Sunday sermon on…", "A devotional for the week
//     of Pentecost…"). The pastor finishes the sentence.
//   - When the prompt already has text: the chip dims and clicking
//     is a no-op. We don't clobber the pastor's draft. If they want
//     a fresh start with the suggestion, they clear the textarea
//     first.
//
// Type gating:
//   - 'sermon'      → most useful, on by default
//   - 'devotional'  → useful, on by default
//   - 'message' / 'announcement' → liturgical context rarely changes
//     the framing; chip is hidden
//
// /api/liturgical is private-cached 1h server-side (S5.1), so this
// fetch is effectively free after the first hit per session.

// Local-time YYYY-MM-DD for the upcoming Sunday. Today if today IS
// Sunday — we want the pastor drafting Sunday morning to still see
// today's context, not "next Sunday".
function upcomingSundayISO() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const dow = d.getDay() // 0 = Sunday
  const daysAhead = dow === 0 ? 0 : 7 - dow
  d.setDate(d.getDate() + daysAhead)
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function formatDateShort(isoYmd, dateLocale) {
  const [y, m, d] = isoYmd.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(dateLocale, {
    month: 'long', day: 'numeric',
  })
}

const SUPPORTED_TYPES = new Set(['sermon', 'devotional'])

export default function LiturgicalSuggestion({ type, prompt, onUse }) {
  const { t, dateLocale } = useLocale()
  const [data, setData] = useState(null)
  const [hidden, setHidden] = useState(false)
  const targetDate = upcomingSundayISO()

  // Sentence-starter per content type — localized, so a pastor drafting
  // in Spanish gets a Spanish opening to finish.
  const seedPrompt = ({ season, feast_name, dateLabel }) => {
    const label = feast_name || season
    if (type === 'sermon')     return t('sug.seedSermon', { label, date: dateLabel })
    if (type === 'devotional') return t('sug.seedDevotional', { label })
    return ''
  }

  useEffect(() => {
    if (!SUPPORTED_TYPES.has(type)) return
    let cancelled = false
    fetch(apiUrl(`/api/liturgical?date=${targetDate}`))
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) {
        if (!d?.season) { setHidden(true); return }
        setData(d)
        setHidden(false)
      }})
      .catch(() => { if (!cancelled) setHidden(true) })
    return () => { cancelled = true }
  }, [type, targetDate])

  if (!SUPPORTED_TYPES.has(type) || hidden || !data) return null

  const dateLabel = formatDateShort(targetDate, dateLocale)
  const label = data.feast_name || data.season
  const isEmpty = !prompt.trim()
  const dotCls = LIT_COLOR_DOT[data.color] ?? LIT_COLOR_DOT_NONE

  const handleClick = () => {
    if (!isEmpty) return
    const seed = seedPrompt({
      season: data.season,
      feast_name: data.feast_name,
      dateLabel,
    })
    if (seed) onUse(seed)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!isEmpty}
      title={isEmpty ? t('sug.seedHint') : t('sug.clearHint')}
      className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition-colors ${
        isEmpty
          ? 'bg-brass-50 dark:bg-ink-800/60 border-brass-200/70 dark:border-brass-900/40 text-brass-700 dark:text-brass-200 hover:bg-brass-100 dark:hover:bg-ink-800'
          : 'bg-parchment-100/60 dark:bg-ink-800/30 border-parchment-300/50 dark:border-brass-900/20 text-ink-500 dark:text-parchment-300/60 cursor-not-allowed'
      }`}
    >
      <Cross size={11} className="shrink-0 opacity-80" />
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotCls}`} />
      <span className="font-semibold">{label}</span>
      {/* De-emphasis by font weight, not by opacity. These two spans used
          opacity-75 / opacity-60, which dropped brass-700 on brass-50 from a
          comfortable 6.36:1 to 3.61:1 and 2.67:1 — both below AA, and axe
          flagged them the moment this chip was audited. Transparency is the
          quiet way to break contrast: the token is compliant, the rendered
          pixels are not. */}
      <span className="font-normal">· {dateLabel}</span>
      {isEmpty && <span className="font-normal">— {t('sug.use')}</span>}
    </button>
  )
}
