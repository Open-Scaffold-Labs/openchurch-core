// Import receipt (MIG.1) — the onboarding and continuity document.
//
// Print-first, same chrome-hiding pattern as the certificate and packet.
// This sheet is what a secretary files in the parish binder: what came
// over, who prepared and approved it, what was held for follow-up and
// why, and exactly what protection applies — no more, no less.
//
// URL: /migration/:id/receipt

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loader2, Printer, ArrowLeft, Undo2 } from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import { useAuth } from '../context/AuthContext'
import { useConfirm } from '../components/ConfirmProvider'
import { useToast } from '../components/ToastProvider'

export default function ImportReceipt() {
  const { t, locale, dateLocale } = useLocale()
  const { user } = useAuth()
  const ask = useConfirm()
  const toast = useToast()
  const { id } = useParams()
  const [batch, setBatch] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Undoing a whole import is the one action on this page, and it is
  // exactly as reversible as any other deletion: every record it removes
  // goes to Archive & Recovery. The confirmation says so — `recoverable`
  // is true here because it is true, and the dialog is only allowed to
  // say it where a capture really happens.
  const undo = async () => {
    if (!(await ask({
      title: t('mig.undoAsk'),
      body: t('mig.undoBody', { n: batch?.receipt?.imported ?? 0 }),
      confirmLabel: t('mig.undoConfirm'),
      recoverable: true,
    }))) return
    setBusy(true)
    try {
      const r = await fetch(apiUrl(`/api/imports/${id}/undo`), { method: 'POST' })
      const body = await r.json().catch(() => ({}))
      const text = body?.message?.[locale] ?? body?.message?.en ?? body?.error
      if (!r.ok) { toast.error(text || t('mig.saveError')); return }
      toast.success(text)
      // The refetch parsed whatever came back without checking the status,
      // so a 500 body was set as the batch and the render below walked into
      // undefined. The undo already succeeded at this point — a failed
      // refresh must not take the page down on top of it.
      const fresh = await fetch(apiUrl(`/api/imports/${id}`))
      if (fresh.ok) setBatch(await fresh.json())
    } catch {
      toast.error(t('mig.saveError'))
    } finally { setBusy(false) }
  }

  useEffect(() => {
    let cancelled = false
    fetch(apiUrl(`/api/imports/${id}`))
      .then(r => { if (!r.ok) throw new Error(t('mig.loadError')); return r.json() })
      .then(d => { if (!cancelled) setBatch(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const r = batch?.receipt

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="print:hidden mb-6 flex items-center justify-between gap-3">
        <Link to="/migration" className="inline-flex items-center gap-1.5 text-sm text-church-700 dark:text-brass-300 hover:underline">
          <ArrowLeft size={15} /> {t('mig.backToStudio')}
        </Link>
        {batch?.can_undo && user?.role === 'admin' && (
          <button onClick={undo} disabled={busy}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-parchment-300 text-ink-700 text-sm font-medium hover:bg-parchment-200/60 disabled:opacity-60 min-h-[40px]">
            {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Undo2 size={15} aria-hidden="true" />}
            {t('mig.undo')}
          </button>
        )}
        <button onClick={() => window.print()}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-church-800 text-parchment-50 text-sm font-medium hover:bg-church-900 min-h-[40px]">
          <Printer size={15} /> {t('mig.print')}
        </button>
      </div>

      <div className="bg-white text-ink-900 mx-auto p-8 sm:p-10 shadow-warm-lg print:shadow-none print:p-0">
        {error ? (
          <p className="text-sm text-rose-700 text-center py-10">{error}</p>
        ) : !batch ? (
          <div className="flex justify-center py-16 print:hidden"><Loader2 size={22} className="animate-spin text-brass-600" /></div>
        ) : !r ? (
          <p className="text-sm text-ink-600 text-center py-10 italic">{t('mig.noReceipt')}</p>
        ) : (
          <>
            <header className="text-center border-b-2 border-brass-600/60 pb-4 mb-6">
              <h1 className="font-display text-3xl font-semibold tracking-wide">{r.parish}</h1>
              <p className="mt-1 font-display text-lg text-ink-700 italic">{t('mig.receiptTitle')}</p>
              <p className="mt-1 text-sm text-ink-600">
                {new Date(r.committed_at).toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            </header>

            <section className="mb-6 text-sm space-y-1">
              <p><span className="text-ink-500">{t('mig.rSource')}:</span> {r.source_name} · {t(`mig.kind.${r.kind}`)} · {r.row_count} {t('mig.rows')}</p>
              {r.prepared_by && <p><span className="text-ink-500">{t('mig.rPrepared')}:</span> {r.prepared_by.name} ({r.prepared_by.email})</p>}
              <p><span className="text-ink-500">{t('mig.rApproved')}:</span> {r.approved_by?.name} ({r.approved_by?.email})</p>
            </section>

            <section className="mb-6">
              <table className="w-full text-sm">
                <tbody>
                  <tr className="border-b border-dotted border-parchment-300/70">
                    <td className="py-2 font-display text-base">{t('mig.rImported')}</td>
                    <td className="py-2 text-right font-semibold">{r.imported}</td>
                  </tr>
                  <tr className="border-b border-dotted border-parchment-300/70">
                    <td className="py-2 font-display text-base">{t('mig.rHeld')}</td>
                    <td className="py-2 text-right">{r.held_for_follow_up}</td>
                  </tr>
                  <tr className="border-b border-dotted border-parchment-300/70">
                    <td className="py-2 font-display text-base">{t('mig.rDupLeft')}</td>
                    <td className="py-2 text-right">{r.duplicates_left_for_review}</td>
                  </tr>
                  {r.duplicates_imported_anyway > 0 && (
                    <tr className="border-b border-dotted border-parchment-300/70">
                      <td className="py-2 font-display text-base">{t('mig.rDupImported')}</td>
                      <td className="py-2 text-right">{r.duplicates_imported_anyway}</td>
                    </tr>
                  )}
                  <tr>
                    <td className="py-2 font-display text-base">{t('mig.rSkipped')}</td>
                    <td className="py-2 text-right">{r.skipped}</td>
                  </tr>
                </tbody>
              </table>
            </section>

            {r.follow_up_reasons?.length > 0 && (
              <section className="mb-6">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-500 mb-1.5">{t('mig.rFollowUp')}</p>
                <ul className="text-sm space-y-1">
                  {r.follow_up_reasons.map((fr, i) => (
                    <li key={i} className="flex justify-between gap-4">
                      <span className="text-ink-700">{fr.message?.[locale] ?? fr.reason}</span>
                      <span className="text-ink-500 whitespace-nowrap">× {fr.count}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-ink-600 italic">{t('mig.rNextStep')}</p>
              </section>
            )}

            {r.ignored_columns?.length > 0 && (
              <section className="mb-6 text-xs text-ink-600">
                <span className="font-semibold">{t('mig.rIgnored')}:</span> {r.ignored_columns.join(', ')}
              </section>
            )}

            <section className="mb-8 rounded-lg bg-parchment-100 px-4 py-3 text-xs text-ink-700 leading-relaxed space-y-2 print:bg-transparent print:border print:border-parchment-300">
              <p>{r.protection?.records}</p>
              <p>{r.protection?.source_file}</p>
              {/* The retention promise, on the artifact itself. A person
                  reading this in six months should not have to wonder why
                  the rows are gone, or whether this page is going too. */}
              {r.protection?.staged_rows && <p>{r.protection.staged_rows}</p>}
            </section>

            {/* Whether the staged rows are still here, said in the one
                place somebody looks a year later. Not a warning — a fact,
                in the same quiet type as everything else. */}
            <section className="mb-6 text-xs text-ink-600 print:hidden">
              {batch?.rows_available === false
                ? <span>{t('mig.rowsRemoved', { date: String(batch.rows_purged_at ?? '').slice(0, 10), n: batch.rows_purged_count ?? 0 })}</span>
                : batch?.rows_available_until
                  ? <span>{t('mig.rowsKeptUntil', { date: batch.rows_available_until })}</span>
                  : null}
            </section>

            {/* If it was undone, the receipt says so — on the printed
                sheet, not just on the screen. A filed receipt that still
                reads as though 200 members arrived would be the most
                expensive kind of tidy. */}
            {batch?.receipt?.undone && (
              <section className="mb-6 rounded-lg border border-parchment-300 px-4 py-3 text-xs text-ink-700 leading-relaxed space-y-1">
                <p className="font-semibold">
                  {t('mig.undoneOn', { date: String(batch.receipt.undone.at).slice(0, 10) })}
                  {batch.receipt.undone.by?.name ? ` · ${batch.receipt.undone.by.name}` : ''}
                </p>
                <p>{t('mig.undoneCounts', {
                  removed: batch.receipt.undone.removed,
                  kept: batch.receipt.undone.left_alone_because_edited,
                })}</p>
                <p>{batch.receipt.undone.note}</p>
              </section>
            )}

            <footer className="pt-3 border-t border-parchment-300 text-center text-[11px] text-ink-500">
              {t('mig.receiptFooter')} · OpenChurch
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
