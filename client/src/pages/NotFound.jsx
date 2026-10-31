// SP-135: an unknown client route used to render a blank content area.
// A calm, translated 404 with one way home — Quiet Craft 5 serif line.
import { useLayoutEffect } from 'react'
import { Link } from 'react-router-dom'
import { useLocale } from '../i18n'

export default function NotFound({ home = '/' }) {
  const { t } = useLocale()

  useLayoutEffect(() => {
    const prev = document.title
    document.title = t('notFound.title')
    return () => { document.title = prev }
  }, [t])

  return (
    <div
      role="status"
      className="flex min-h-[50vh] flex-col items-center justify-center px-4 py-16 text-center"
    >
      <h1 className="font-display text-2xl font-semibold text-church-800 dark:text-brass-200">
        {t('notFound.title')}
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-600 dark:text-parchment-300">
        {t('notFound.body')}
      </p>
      <Link
        to={home}
        className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-church-700 dark:text-brass-300 hover:underline"
      >
        <span aria-hidden="true">←</span> {t('notFound.home')}
      </Link>
    </div>
  )
}
