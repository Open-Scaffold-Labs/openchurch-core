import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Loader2, Newspaper } from 'lucide-react'
import { apiUrl } from '../api'
import { LIT_COLOR_TEXT, LIT_COLOR_DOT, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'
import { useLocale } from '../i18n'

// Public read-online bulletin (BUL.3b). Token-free; reached at
// /p/:slug/bulletin. Shows the parish's most recent PUBLISHED bulletin
// (drafts 404 server-side). Shell matches the other public pages —
// parchment background, brand wordmark, "Powered by OpenChurch" footer.

function fmtLong(iso, dateLocale) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function Section({ title, body }) {
  if (!body || !body.trim()) return null
  return (
    <section className="mt-6">
      <h2 className="text-xs font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300 border-b border-parchment-300/60 dark:border-brass-900/30 pb-1.5 mb-2">
        {title}
      </h2>
      <p className="text-sm text-ink-800 dark:text-parchment-200 leading-relaxed whitespace-pre-line">{body}</p>
    </section>
  )
}

export default function PublicBulletin() {
  // User-visible chrome goes through t(). Org name, section bodies,
  // liturgical feast / season, and the bulletin date stay parish data.
  const { t, dateLocale, setPublicLocale } = useLocale()
  const { slug } = useParams()
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(apiUrl(`/api/public/${slug}/bulletin`))
      .then(r => {
        if (r.status === 404) throw new Error('not-found')
        if (!r.ok) throw new Error(`Failed (${r.status})`)
        return r.json()
      })
      .then(d => {
        if (cancelled || !d) return
        // The parish's language, from the endpoint — nobody is signed in here.
        setPublicLocale(d.org?.locale)
        setData(d)
      })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [slug, setPublicLocale])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-parchment-100 dark:bg-ink-900">
        <Loader2 className="animate-spin text-brass-600" size={32} />
      </div>
    )
  }

  if (err === 'not-found') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-parchment-100 dark:bg-ink-900 p-6">
        <div className="max-w-md text-center space-y-3">
          <Newspaper className="mx-auto text-brass-500" size={36} />
          <h1 className="text-xl font-bold text-ink-900 dark:text-parchment-50 font-display">{t('bulletin.notFound')}</h1>
          <p className="text-sm text-ink-700 dark:text-parchment-200">
            {t('bulletin.notFoundBody')}
          </p>
        </div>
      </div>
    )
  }

  if (err || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-parchment-100 dark:bg-ink-900 p-6">
        <div className="max-w-md text-center space-y-3">
          <Newspaper className="mx-auto text-brass-500" size={36} />
          <h1 className="text-xl font-bold text-ink-900 dark:text-parchment-50 font-display">{t('bulletin.loadFailTitle')}</h1>
          <p className="text-sm text-ink-700 dark:text-parchment-200">
            {t('bulletin.loadFailBody')}
          </p>
        </div>
      </div>
    )
  }

  const { org, bulletin, liturgical } = data
  const litLabel = liturgical?.feast_name || liturgical?.season

  return (
    <div className="min-h-screen bg-parchment-100 dark:bg-ink-900 py-8 px-4">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="max-w-2xl mx-auto"
      >
        <div className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
          {/* Liturgical color band */}
          <div className={`h-2 ${LIT_COLOR_DOT[liturgical?.color] ?? 'bg-brass-500'}`} />

          <div className="p-6 sm:p-8">
            <header className="text-center pb-4 border-b border-parchment-300/60 dark:border-brass-900/30">
              <p className="text-[11px] uppercase tracking-widest text-brass-600 dark:text-brass-300 font-semibold">{t('bulletin.title')}</p>
              <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 mt-1">{org?.name}</h1>
              <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">{fmtLong(bulletin.date, dateLocale)}</p>
              {litLabel && (
                <span className={`inline-flex items-center gap-1.5 mt-3 text-xs font-medium px-2.5 py-1 rounded-md border ${LIT_COLOR_TEXT[liturgical?.color] ?? LIT_COLOR_TEXT.White}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${LIT_COLOR_DOT[liturgical?.color] ?? LIT_COLOR_DOT_NONE}`} />
                  {litLabel}
                </span>
              )}
            </header>

            <Section title={t('bulletin.readings')} body={bulletin.readings} />
            <Section title={t('bulletin.announcements')} body={bulletin.announcements} />
            <Section title={t('bulletin.intentions')} body={bulletin.intentions} />
            <Section title={t('bulletin.pastor')} body={bulletin.pastor_note} />
          </div>
        </div>

        <footer className="text-center text-[11px] text-ink-500 dark:text-parchment-300/60 pt-4">
          {t('bulletin.powered')}
        </footer>
      </motion.div>
    </div>
  )
}
