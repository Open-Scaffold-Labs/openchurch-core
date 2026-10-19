// Printable offerings sheet (BILL.2) — the paper a family actually holds.
//
// Same print-first pattern as the certificate and the Sunday Packet: the
// toolbar hides on print, the sheet owns the page. Print ≠ emailed
// (OC-READY-01-023 / STMT-01): screen chrome says print/PDF only; the
// paper footer stays a live print marker, not a send. Deliberately warm
// and quiet — this may be handed to a widow at a funeral arrangement, so
// it reads as a record of an offering, never as a demand for money. No
// "amount due" in red, no payment terms, no late language.
//
// URL: /offerings/:id/print

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loader2, Printer, ArrowLeft } from 'lucide-react'
import LoadFailure from '../components/LoadFailure'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { formatStoredDate } from '../utils/dates'

function knownNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function positiveIntId(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v
  if (typeof v === 'string' && /^[1-9]\d*$/.test(v)) {
    const n = Number(v)
    if (Number.isSafeInteger(n)) return n
  }
  return null
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function money(v, unavailable = '—') {
  const n = knownNumber(v)
  if (n == null) return unavailable
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function isInvoiceDetail(body) {
  return isPlainObject(body)
    && positiveIntId(body.id) != null
    && Array.isArray(body.lines)
    && body.lines.every(isPlainObject)
    && Array.isArray(body.payments)
    && body.payments.every(isPlainObject)
}

export default function InvoicePrint() {
  const { t, dateLocale } = useLocale()
  const { id } = useParams()
  const { user } = useAuth()
  const [inv, setInv] = useState(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setInv(null)
    setFailed(false)
    fetch(apiUrl(`/api/invoices/${id}`))
      .then(r => { if (!r.ok) throw new Error('unread'); return r.json() })
      .then(d => {
        if (cancelled) return
        if (!isInvoiceDetail(d) || positiveIntId(d.id) !== positiveIntId(id)) throw new Error('shape')
        setInv(d)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [id, attempt])

  const unavailable = t('money.unavailable')
  const totalN = knownNumber(inv?.total)
  const paidN = knownNumber(inv?.amount_paid)
  const balance = totalN == null || paidN == null ? null : Math.max(totalN - paidN, 0)
  const waivedN = knownNumber(inv?.waived_amount)
  const fmtDate = (d, opts = { month: 'long', day: 'numeric', year: 'numeric' }) =>
    new Date(d).toLocaleDateString(dateLocale, opts)

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="print:hidden mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link to="/offerings" className="inline-flex items-center gap-1.5 text-sm text-church-700 dark:text-brass-300 hover:underline">
          <ArrowLeft size={15} /> {t('bil.backToOfferings')}
        </Link>
        <button onClick={() => window.print()}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-church-800 text-parchment-50 text-sm font-medium hover:bg-church-900 min-h-[40px]">
          <Printer size={15} /> {t('bil.print')}
        </button>
        {/* Print ≠ emailed (OC-READY-01-023 / STMT-01 pattern). Screen
            chrome only — the paper stays a live print marker. */}
        <p data-testid="invoice-print-not-emailed" className="w-full text-sm text-ink-500 dark:text-parchment-300/70 print:hidden">
          {t('bil.printHonesty')}
        </p>
      </div>

      <div className="bg-white text-ink-900 mx-auto p-8 sm:p-10 shadow-warm-lg print:shadow-none print:p-0">
        {failed ? (
          <div className="print:hidden">
            <LoadFailure body={t('bil.detailFailedBody')} onRetry={() => setAttempt(n => n + 1)} />
          </div>
        ) : !inv ? (
          <div className="flex justify-center py-16 print:hidden"><Loader2 size={22} className="animate-spin text-brass-600" /></div>
        ) : (
          <>
            <header className="text-center border-b-2 border-brass-600/60 pb-4 mb-6">
              <h1 className="font-display text-3xl font-semibold tracking-wide">{user?.organization?.name || 'OpenChurch'}</h1>
              <p className="mt-1 font-display text-lg text-ink-700 italic">{t('bil.sheetTitle')}</p>
              <p className="mt-1 text-sm text-ink-600">
                {inv.invoice_no ? `${t('bil.no')} ${inv.invoice_no} · ` : ''}
                {inv.issued_at ? fmtDate(inv.issued_at) : fmtDate(inv.created_at)}
              </p>
            </header>

            <section className="mb-6">
              <p className="font-display text-xl">{inv.title}</p>
              <p className="mt-1 text-sm text-ink-600">
                {t('bil.forName')} {inv.payer_member_name || inv.payer_name}
                {inv.event_title && ` · ${inv.event_title}${inv.event_date ? `, ${formatStoredDate(inv.event_date, { month: 'long', day: 'numeric', year: 'numeric' }, dateLocale)}` : ''}`}
              </p>
            </section>

            <section className="mb-6">
              <table className="w-full text-sm">
                <tbody>
                  {inv.lines.map(l => (
                    <tr key={l.id} className="border-b border-dotted border-parchment-300/70 last:border-0">
                      <td className="py-2 font-display text-base">
                        {l.description}
                        {Number(l.qty) !== 1 && <span className="text-ink-500"> × {Number(l.qty)}</span>}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">{money(l.amount, unavailable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="mb-8 ml-auto max-w-xs space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-ink-600">{t('bil.subtotal')}</span><span>{money(inv.subtotal, unavailable)}</span></div>
              {(waivedN == null || waivedN > 0) && (
                <div className="flex justify-between text-ink-600 italic">
                  <span>{t('bil.waivedLine')}</span><span>{waivedN == null ? unavailable : `−${money(inv.waived_amount)}`}</span>
                </div>
              )}
              {paidN == null ? (
                <div className="flex justify-between"><span className="text-ink-600">{t('bil.received')}</span><span>{unavailable}</span></div>
              ) : paidN > 0 ? (
                <div className="flex justify-between"><span className="text-ink-600">{t('bil.received')}</span><span>{money(inv.amount_paid)}</span></div>
              ) : null}
              <div className="flex justify-between border-t border-brass-600/40 pt-1.5 font-display text-base font-semibold">
                <span>{inv.status === 'paid' || inv.status === 'waived' ? t('bil.settled') : t('bil.balance')}</span>
                <span>{balance == null ? unavailable : (inv.status === 'paid' || inv.status === 'waived' ? '—' : money(balance))}</span>
              </div>
            </section>

            {inv.payments.filter(p => !p.refunded_at).length > 0 && (
              <section className="mb-8 text-xs text-ink-600">
                <p className="font-semibold uppercase tracking-widest text-[10px] text-ink-500 mb-1">{t('bil.payments')}</p>
                {inv.payments.filter(p => !p.refunded_at).map(p => (
                  <p key={p.id}>
                    {money(p.amount, unavailable)} · {t(`bil.method.${p.method}`)}{p.is_deposit ? ` · ${t('bil.deposit')}` : ''} · {fmtDate(p.received_at, { month: 'long', day: 'numeric', year: 'numeric' })}
                  </p>
                ))}
              </section>
            )}

            <footer className="pt-3 border-t border-parchment-300 text-center text-[11px] text-ink-500">
              {t('bil.sheetFooter')}
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
