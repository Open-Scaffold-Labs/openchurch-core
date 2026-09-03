import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, Printer, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { formatLocalDate, todayLocalISO } from '../utils/dates'

// Sacramental certificate (SAC.3) — a formal, printable certificate for a
// single record. Rendered in-app (the App sidebar is print:hidden, like the
// donor statement) so window.print() / "Save as PDF" yields a clean page.
// No new dependency: it's styled HTML the browser prints.

// Titles and phrases live in the i18n dictionaries (cert.title.*,
// cert.phrase.*) so the certificate prints in the parish's language.
// Spanish phrases avoid gendered participles — "recibió el sacramento
// de…" serves every name with reverence.
const CERT_TYPES = ['baptism', 'reconciliation', 'first_communion', 'confirmation', 'marriage', 'holy_orders', 'anointing', 'burial']

export default function SacramentCertificate() {
  const { id } = useParams()
  const { user } = useAuth()
  const { t, dateLocale } = useLocale()
  const churchName = user?.organization?.name || 'Our Parish'

  const [record,  setRecord]  = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    fetch(apiUrl(`/api/sacraments/${id}`))
      .then(async r => {
        if (r.status === 404) throw new Error('This record could not be found.')
        if (!r.ok) throw new Error(`Failed to load (${r.status})`)
        return r.json()
      })
      .then(d => { if (!cancelled) setRecord(d) })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return <div className="flex justify-center py-24"><Loader2 size={24} className="animate-spin text-brass-600" /></div>
  }
  if (error || !record) {
    return (
      <div className="max-w-xl mx-auto py-16 text-center">
        <p className="text-sm text-rose-700 dark:text-rose-300 mb-4">{error || 'Record not found.'}</p>
        <Link to="/register" className="text-sm text-church-700 dark:text-brass-300 hover:underline">← Back to the register</Link>
      </div>
    )
  }

  // A 200 is not the same as a record. Observed 27 Aug: a 200 carrying `{}`
  // rendered a complete, printable, letterheaded certificate — parish name,
  // "This is to certify that", the rites language, a signature line and
  // today's date — certifying no person, no sacrament, no date and no
  // minister, offered with "Print / Save as PDF". A document that leaves the
  // building attesting to nothing is worse than an error page.
  //
  // The bar is deliberately the two facts without which the sentence cannot
  // be true: WHO and WHICH SACRAMENT. Date, place, minister and certificate
  // number are genuinely absent from many historical entries and are already
  // rendered conditionally — they are not required here.
  const isText = v => typeof v === 'string' && v.trim().length > 0
  if (record.id == null || !isText(record.type) || !isText(record.member_name)) {
    return (
      <div className="max-w-xl mx-auto py-16 text-center space-y-3">
        <p className="font-display text-xl text-church-800 dark:text-brass-200">{t('cert.incompleteTitle')}</p>
        <p className="text-sm text-ink-600 dark:text-parchment-300">{t('cert.incompleteBody')}</p>
        <Link to="/register" className="inline-block text-sm text-church-700 dark:text-brass-300 hover:underline">
          ← {t('cert.back')}
        </Link>
      </div>
    )
  }

  // REG.1 — a certificate is an extract from the register, so a void entry
  // must never produce one. Refusing here rather than watermarking: a
  // watermarked certificate still leaves the building, and the whole point
  // of voiding is that this entry no longer speaks for the parish.
  if (record.voided_at) {
    return (
      <div className="max-w-xl mx-auto py-16 text-center space-y-3">
        <p className="font-display text-xl text-church-800 dark:text-brass-200">This entry is void</p>
        <p className="text-sm text-ink-600 dark:text-parchment-300">
          No certificate can be issued from a voided register entry. It remains in the
          record, with the reason it was voided, on the register page.
        </p>
        {record.voided_reason && (
          <p className="text-sm italic text-ink-500 dark:text-parchment-400">“{record.voided_reason}”</p>
        )}
        <Link to="/register" className="inline-block text-sm text-church-700 dark:text-brass-300 hover:underline">
          ← Back to the register
        </Link>
      </div>
    )
  }

  const known  = CERT_TYPES.includes(record.type)
  const title  = known ? t(`cert.title.${record.type}`)  : 'Certificate'
  const phrase = known ? t(`cert.phrase.${record.type}`) : 'received this sacrament'
  const name   = record.member_name || '—'

  // Build the body sentence, omitting clauses with no data.
  const clauses = []
  if (record.date)  clauses.push(`${t('cert.on')} ${formatLocalDate(record.date, { year: 'numeric', month: 'long', day: 'numeric' }, dateLocale)}`)
  if (record.place) clauses.push(`${t('cert.at')} ${record.place}`)

  // Baptism names godparents; confirmation names sponsors. Same shape, two
  // words, and using the wrong one in front of a rector is the kind of
  // mistake that ends a demo — so the label follows the sacrament, and the
  // singular/plural follows the count.
  const meta       = record.meta_attributes ?? {}
  const witnesses  = (record.type === 'confirmation' ? meta.sponsors : meta.godparents) ?? []
  const witnessKey = record.type === 'confirmation'
    ? (witnesses.length === 1 ? 'cert.sponsor'   : 'cert.sponsors')
    : (witnesses.length === 1 ? 'cert.godparent' : 'cert.godparents')
  const witnessLabel = t(witnessKey)

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      {/* Toolbar — hidden on print */}
      <div className="print:hidden mb-6 flex items-center justify-between">
        <Link to="/register" className="inline-flex items-center gap-1 text-sm text-ink-600 dark:text-parchment-200 hover:text-church-700 dark:hover:text-brass-300">
          <ChevronLeft size={16} /> {t('cert.back')}
        </Link>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900"
        >
          <Printer size={15} /> {t('cert.print')}
        </button>
      </div>

      {/* The certificate itself */}
      {/* The page shape is a MINIMUM, not a cage.
          Observed 27 Aug at 390px (iPhone): the hard aspect-ratio gave the
          article a definite height, so the godparents, the signature line and
          the issue line spilled out BELOW the ornamental border and sat on the
          parchment — a certificate whose frame cuts across its own text, on
          the exact screen a secretary is most likely to print from. The ratio
          now applies from sm: up and on print, where it is page shape; below
          that the box grows to hold the document. */}
      <article className="relative bg-white text-ink-900 mx-auto p-6 sm:p-14 shadow-warm-lg print:shadow-none sm:aspect-[1/1.294] print:aspect-[1/1.294]">
        {/* Double ornamental border */}
        <div className="absolute inset-3 border-2 border-brass-700/70 pointer-events-none" />
        <div className="absolute inset-5 border border-brass-700/40 pointer-events-none" />

        <div className="relative sm:h-full print:h-full flex flex-col items-center text-center">
          <p className="font-display text-2xl sm:text-3xl font-semibold text-church-800 tracking-wide">{churchName}</p>
          <div className="mt-1 mb-6 h-px w-24 bg-brass-700/50" />

          <h1 className="font-display text-3xl sm:text-4xl font-bold text-church-900">{title}</h1>

          <div className="flex-1 flex flex-col items-center justify-center gap-5 max-w-xl">
            <p className="text-sm sm:text-base text-ink-600 italic">{t('cert.certify')}</p>
            <p className="font-display text-4xl sm:text-5xl font-semibold text-ink-900 leading-tight border-b border-brass-700/30 px-6 pb-2">
              {name}
            </p>
            <p className="text-base sm:text-lg text-ink-700 leading-relaxed">
              {phrase}{clauses.length ? ' ' + clauses.join(', ') : ''}, {t('cert.rites')}{record.minister ? `, ${t('cert.administeredBy')} ${record.minister}` : ''}.
            </p>

            {/* Godparents / sponsors. A baptismal certificate that names no
                godparents is not the document a parish issues — they are a
                canonical part of the record, which is why they have their own
                structured home in meta_attributes rather than living in notes.
                Rendered only when present, so a record without them still
                prints as a clean certificate rather than an empty label. */}
            {witnesses.length > 0 && (
              <div className="pt-1">
                <p className="text-[11px] uppercase tracking-widest text-ink-500">{witnessLabel}</p>
                <p className="mt-1 font-display text-xl sm:text-2xl text-ink-800 leading-snug">
                  {witnesses.join(' · ')}
                </p>
              </div>
            )}
          </div>

          {/* Footer: signature + issue line */}
          <div className="w-full mt-8 grid grid-cols-2 gap-8 items-end text-left">
            <div>
              <div className="h-10 border-b border-ink-400" />
              <p className="mt-1 text-[11px] uppercase tracking-widest text-ink-500">
                {record.minister ? record.minister : t('cert.officiant')}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-widest text-ink-500">
                {record.certificate_no ? <>{t('cert.no')} {record.certificate_no}<br /></> : null}
                {t('cert.issued')} {formatLocalDate(todayLocalISO(), { year: 'numeric', month: 'long', day: 'numeric' }, dateLocale)}
              </p>
            </div>
          </div>
        </div>
      </article>
    </div>
  )
}
