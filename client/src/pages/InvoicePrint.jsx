// Printable offerings sheet (BILL.2) — the paper a family actually holds.
//
// Same print-first pattern as the certificate and the Sunday Packet: the
// toolbar hides on print, the sheet owns the page. Deliberately warm and
// quiet — this may be handed to a widow at a funeral arrangement, so it
// reads as a record of an offering, never as a demand for money. No
// "amount due" in red, no payment terms, no late language.
//
// URL: /offerings/:id/print

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loader2, Printer, ArrowLeft } from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import { useAuth } from '../context/AuthContext'

const money = v => '$' + Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function InvoicePrint() {
  const { t, dateLocale } = useLocale()
  const { id } = useParams()
  const { user } = useAuth()
  const [inv, setInv] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(apiUrl(`/api/invoices/${id}`))
      .then(r => { if (!r.ok) throw new Error(t('bil.loadError')); return r.json() })
      .then(d => { if (!cancelled) setInv(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const balance = inv ? Math.max(Number(inv.total) - Number(inv.amount_paid), 0) : 0
  const fmtDate = (d, opts = { month: 'long', day: 'numeric', year: 'numeric' }) =>
    new Date(d).toLocaleDateString(dateLocale, opts)

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="print:hidden mb-6 flex items-center justify-between gap-3">
        <Link to="/offerings" className="inline-flex items-center gap-1.5 text-sm text-church-700 dark:text-brass-300 hover:underline">
          <ArrowLeft size={15} /> {t('bil.backToOfferings')}
        </Link>
        <button onClick={() => window.print()}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-church-800 text-parchment-50 text-sm font-medium hover:bg-church-900 min-h-[40px]">
          <Printer size={15} /> {t('bil.print')}
        </button>
      </div>

      <div className="bg-white text-ink-900 mx-auto p-8 sm:p-10 shadow-warm-lg print:shadow-none print:p-0">
        {error ? (
          <p className="text-sm text-rose-700 text-center py-10">{error}</p>
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
                {inv.event_title && ` · ${inv.event_title}${inv.event_date ? `, ${fmtDate(inv.event_date)}` : ''}`}
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
                      <td className="py-2 text-right whitespace-nowrap">{money(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="mb-8 ml-auto max-w-xs space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-ink-600">{t('bil.subtotal')}</span><span>{money(inv.subtotal)}</span></div>
              {Number(inv.waived_amount) > 0 && (
                <div className="flex justify-between text-ink-600 italic">
                  <span>{t('bil.waivedLine')}</span><span>−{money(inv.waived_amount)}</span>
                </div>
              )}
              {Number(inv.amount_paid) > 0 && (
                <div className="flex justify-between"><span className="text-ink-600">{t('bil.received')}</span><span>{money(inv.amount_paid)}</span></div>
              )}
              <div className="flex justify-between border-t border-brass-600/40 pt-1.5 font-display text-base font-semibold">
                <span>{inv.status === 'paid' || inv.status === 'waived' ? t('bil.settled') : t('bil.balance')}</span>
                <span>{inv.status === 'paid' || inv.status === 'waived' ? '—' : money(balance)}</span>
              </div>
            </section>

            {inv.payments.filter(p => !p.refunded_at).length > 0 && (
              <section className="mb-8 text-xs text-ink-600">
                <p className="font-semibold uppercase tracking-widest text-[10px] text-ink-500 mb-1">{t('bil.payments')}</p>
                {inv.payments.filter(p => !p.refunded_at).map(p => (
                  <p key={p.id}>
                    {money(p.amount)} · {t(`bil.method.${p.method}`)}{p.is_deposit ? ` · ${t('bil.deposit')}` : ''} · {fmtDate(p.received_at, { month: 'long', day: 'numeric', year: 'numeric' })}
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
