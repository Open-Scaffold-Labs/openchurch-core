// OC-WEB-1 PR-C — render allowlisted published site blocks on /p/:slug.
// Bilingual fields are { en, es }; the visitor EN/ES choice comes from useLocale.
// Admin look is applied via data-os-look; visitors only get a high-contrast toggle.

import { Link } from 'react-router-dom'
import { Clock, MapPin, Heart, Users, HelpCircle, FileText, Calendar } from 'lucide-react'
import { useLocale } from '../i18n'

function bt(value, locale) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return ''
  const lang = locale === 'es' ? 'es' : 'en'
  return value[lang] || value.en || value.es || ''
}

function linesOf(value, locale) {
  return String(bt(value, locale) || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

const card = 'bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 mb-6'
const h2 = 'text-sm font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200'

function Block({ block, slug, locale }) {
  switch (block.type) {
    case 'hero_split':
      return (
        <section className="text-center mb-10" data-block="hero_split">
          {bt(block.eyebrow, locale) && (
            <p className="text-xs uppercase tracking-wider text-brass-700 dark:text-brass-300 mb-2">
              {bt(block.eyebrow, locale)}
            </p>
          )}
          <h1 className="font-display text-4xl md:text-5xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
            {bt(block.headline, locale)}
          </h1>
          {bt(block.subheadline, locale) && (
            <p className="mt-4 text-lg md:text-xl text-ink-600 dark:text-parchment-200 font-display italic">
              {bt(block.subheadline, locale)}
            </p>
          )}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {block.ctaLink && (
              <a
                href={block.ctaLink}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-parchment-50 text-sm font-semibold shadow-warm"
                style={{ backgroundColor: 'var(--parish-accent, #5A1E23)' }}
              >
                {bt(block.ctaText, locale) || '—'}
              </a>
            )}
            {block.secondaryCtaText && block.secondaryCtaLink && (
              <a
                href={block.secondaryCtaLink}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-church-900/30 dark:border-brass-300/40 text-church-900 dark:text-brass-200 text-sm font-semibold"
              >
                {bt(block.secondaryCtaText, locale)}
              </a>
            )}
          </div>
        </section>
      )

    case 'mass_confession_times': {
      const mass = linesOf(block.mass_times, locale)
      const confession = linesOf(block.confession_times, locale)
      if (!mass.length && !confession.length) return null
      return (
        <section className={card} data-block="mass_confession_times">
          <div className="flex items-center gap-2 mb-4">
            <Clock size={15} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
            <h2 className={h2}>{bt(block.title, locale)}</h2>
          </div>
          {mass.length > 0 && (
            <div className="mb-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/80 mb-2">
                {locale === 'es' ? 'Misas' : 'Mass'}
              </h3>
              <ul className="space-y-2">
                {mass.map((line, i) => (
                  <li key={`m-${i}`} className="text-base text-ink-800 dark:text-parchment-100">{line}</li>
                ))}
              </ul>
            </div>
          )}
          {confession.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/80 mb-2">
                {locale === 'es' ? 'Confesiones' : 'Confession'}
              </h3>
              <ul className="space-y-2">
                {confession.map((line, i) => (
                  <li key={`c-${i}`} className="text-base text-ink-800 dark:text-parchment-100">{line}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )
    }

    case 'public_documents_vault': {
      const docs = Array.isArray(block.documents) ? block.documents : []
      return (
        <section className={card} data-block="public_documents_vault">
          <div className="flex items-center gap-2 mb-4">
            <FileText size={15} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
            <h2 className={h2}>{bt(block.title, locale)}</h2>
          </div>
          {docs.length === 0 ? (
            <p className="text-sm text-ink-500 dark:text-parchment-300/70">
              {locale === 'es' ? 'Pronto habrá boletines aquí.' : 'Bulletins will appear here soon.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {docs.map((d, i) => (
                <li key={i}>
                  <a
                    href={d.url}
                    className="inline-flex items-center min-h-6 py-1 text-sm font-semibold text-church-800 dark:text-brass-300 hover:underline"
                    rel={String(d.url || '').startsWith('http') ? 'noopener noreferrer' : undefined}
                    target={String(d.url || '').startsWith('http') ? '_blank' : undefined}
                  >
                    {bt(d.title, locale)}
                  </a>
                  {bt(d.category, locale) && (
                    <span className="ml-2 text-xs text-ink-500 dark:text-parchment-300/70">
                      {bt(d.category, locale)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )
    }

    case 'parish_events': {
      const events = Array.isArray(block.events) ? block.events.slice(0, block.limit || 10) : []
      return (
        <section className={card} data-block="parish_events">
          <div className="flex items-center gap-2 mb-4">
            <Calendar size={15} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
            <h2 className={h2}>{bt(block.title, locale)}</h2>
          </div>
          {events.length === 0 ? (
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mb-3">
              {locale === 'es' ? 'No hay eventos publicados todavía.' : 'No upcoming events listed yet.'}
            </p>
          ) : (
            <ul className="space-y-3 mb-3">
              {events.map((ev, i) => (
                <li key={i} className="text-base text-ink-800 dark:text-parchment-100">
                  <strong>{bt(ev.title, locale)}</strong>
                  {ev.date && <span className="ml-2 text-sm text-ink-500">{ev.date}</span>}
                  {bt(ev.place, locale) && (
                    <div className="text-sm text-ink-600 dark:text-parchment-200">{bt(ev.place, locale)}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {slug && (
            <Link to={`/p/${slug}/events`} className="inline-flex items-center min-h-6 py-1 text-sm font-semibold text-church-800 dark:text-brass-300 hover:underline">
              {locale === 'es' ? 'Ver todos los eventos' : 'See all events'}
            </Link>
          )}
        </section>
      )
    }

    case 'donation_dues_portal': {
      const href = block.portalUrl || (slug ? `/p/${slug}/give` : '/give')
      return (
        <section className={card} data-block="donation_dues_portal">
          <div className="flex items-center gap-2 mb-3">
            <Heart size={15} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
            <h2 className={h2}>{bt(block.title, locale)}</h2>
          </div>
          {bt(block.description, locale) && (
            <p className="text-base text-ink-700 dark:text-parchment-200 mb-4">
              {bt(block.description, locale)}
            </p>
          )}
          <Link
            to={href}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-parchment-50 text-sm font-semibold shadow-warm"
            style={{ backgroundColor: 'var(--parish-accent, #5A1E23)' }}
          >
            <Heart size={15} aria-hidden="true" />
            {bt(block.ctaText, locale)}
          </Link>
        </section>
      )
    }

    case 'location_hours_map':
      return (
        <section className={card} data-block="location_hours_map">
          <div className="flex items-center gap-2 mb-3">
            <MapPin size={15} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
            <h2 className={h2}>{bt(block.title, locale)}</h2>
          </div>
          {bt(block.address, locale) && (
            <p className="text-base text-ink-800 dark:text-parchment-100 mb-2">{bt(block.address, locale)}</p>
          )}
          {bt(block.hoursSummary, locale) && (
            <p className="text-sm text-ink-600 dark:text-parchment-200">{bt(block.hoursSummary, locale)}</p>
          )}
          {block.mapUrl && (
            <a
              href={block.mapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center min-h-6 mt-3 py-1 text-sm font-semibold text-church-800 dark:text-brass-300 hover:underline"
            >
              {locale === 'es' ? 'Cómo llegar' : 'Directions'}
            </a>
          )}
        </section>
      )

    case 'team_roster_grid': {
      const members = Array.isArray(block.members) ? block.members : []
      return (
        <section className={card} data-block="team_roster_grid">
          <div className="flex items-center gap-2 mb-4">
            <Users size={15} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
            <h2 className={h2}>{bt(block.title, locale)}</h2>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {members.map((m, i) => (
              <li key={i} className="rounded-xl border border-parchment-300/50 dark:border-brass-900/30 p-3">
                <div className="font-semibold text-ink-900 dark:text-parchment-50">{bt(m.name, locale)}</div>
                {bt(m.role, locale) && (
                  <div className="text-sm text-ink-600 dark:text-parchment-200">{bt(m.role, locale)}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )
    }

    case 'faq_accordion': {
      const faqs = Array.isArray(block.faqs) ? block.faqs : []
      return (
        <section className={card} data-block="faq_accordion">
          <div className="flex items-center gap-2 mb-4">
            <HelpCircle size={15} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
            <h2 className={h2}>{bt(block.title, locale)}</h2>
          </div>
          <div className="space-y-2">
            {faqs.map((f, i) => (
              <details key={i} className="group rounded-lg border border-parchment-300/60 dark:border-brass-900/30 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-ink-800 dark:text-parchment-100 list-none flex items-center justify-between gap-2">
                  <span>{bt(f.question, locale)}</span>
                  <span className="text-ink-400 group-open:rotate-45 transition-transform" aria-hidden="true">+</span>
                </summary>
                <p className="mt-2 text-sm text-ink-700 dark:text-parchment-200 leading-relaxed">
                  {bt(f.answer, locale)}
                </p>
              </details>
            ))}
          </div>
        </section>
      )
    }

    default:
      return null
  }
}

export default function PublicSiteBlocks({ site, slug, highContrast, onToggleHighContrast }) {
  const { locale, setLocale, t } = useLocale()
  const pages = Array.isArray(site?.doc?.pages) ? site.doc.pages : []
  const home = pages.find((p) => p.id === 'home') || pages[0]
  const blocks = Array.isArray(home?.blocks) ? home.blocks : []
  if (!blocks.length) return null

  return (
    <div data-os-look={highContrast ? 'high-contrast' : (site.look_id || 'warm-editorial')}>
      <div className="flex flex-wrap items-center justify-center gap-2 mb-8" role="group" aria-label={t('prefs.langInline.en') === 'English' ? 'Language and contrast' : 'Idioma y contraste'}>
        <button
          type="button"
          onClick={() => setLocale('en')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${locale === 'en' ? 'bg-church-900 text-parchment-50 border-church-900' : 'border-parchment-300 text-ink-700 dark:text-parchment-200'}`}
          aria-pressed={locale === 'en'}
        >
          {t('prefs.english')}
        </button>
        <button
          type="button"
          onClick={() => setLocale('es')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${locale === 'es' ? 'bg-church-900 text-parchment-50 border-church-900' : 'border-parchment-300 text-ink-700 dark:text-parchment-200'}`}
          aria-pressed={locale === 'es'}
        >
          {t('prefs.spanish')}
        </button>
        {site.visitor_controls?.high_contrast_toggle !== false && (
          <button
            type="button"
            onClick={onToggleHighContrast}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${highContrast ? 'bg-ink-950 text-parchment-50 border-ink-950' : 'border-parchment-300 text-ink-700 dark:text-parchment-200'}`}
            aria-pressed={highContrast}
          >
            {locale === 'es' ? 'Alto contraste' : 'High contrast'}
          </button>
        )}
      </div>
      {blocks.map((block, i) => (
        <Block key={`${block.type}-${i}`} block={block} slug={slug} locale={locale} />
      ))}
    </div>
  )
}
