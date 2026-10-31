// Cutover scoreboard: the old system's trial balance (CSV) against
// OpenChurch, five lines, penny by penny. Read-only. A line the file cannot
// fully answer is UNKNOWN, never $0.00. "Cutover ready" only when every line
// is a complete match; the accountant's sign-off is then recorded
// append-only (the server re-checks readiness).
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Scale, Download, FileDown } from 'lucide-react'
import PageWrapper, { PageHeader } from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'

export const fmtCents = c => (c === null || c === undefined) ? null
  : `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function FinanceCutover() {
  const { user } = useAuth()
  const { t } = useLocale()
  const toast = useToast()
  const isAdmin = user?.role === 'admin'
  const [csv, setCsv] = useState('')
  const [asOf, setAsOf] = useState('')
  const [sb, setSb] = useState(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [signedOn, setSignedOn] = useState('')
  const [signoffs, setSignoffs] = useState(null)

  const loadSignoffs = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/finance/cutover/signoffs'))
      if (!r.ok) throw new Error()
      setSignoffs((await r.json()).signoffs)
    } catch { setSignoffs('error') }
  }, [])
  useEffect(() => { loadSignoffs() }, [loadSignoffs])

  const post = (path, body) => fetch(apiUrl(`/api/finance/cutover/${path}`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

  const run = async () => {
    if (!csv.trim() || !asOf) { toast.error(t('cut.needs')); return }
    setBusy(true); setSb(null)
    try {
      const r = await post('scoreboard', { csv, as_of: asOf })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || t('cut.error'))
      setSb(d)
    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
  }

  const exportCsv = async () => {
    setBusy(true)
    try {
      const r = await post('export', { csv, as_of: asOf })
      if (!r.ok) throw new Error(t('cut.error'))
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob); a.download = `cutover-scoreboard-${asOf}.csv`; a.click()
    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
  }

  const signOff = async () => {
    if (!name.trim() || !signedOn) { toast.error(t('cut.signNeeds')); return }
    setBusy(true)
    try {
      const r = await post('signoffs', { csv, as_of: asOf, accountant_name: name, signed_on: signedOn })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || t('cut.error'))
      toast.success(t('cut.signed')); setName(''); setSignedOn(''); loadSignoffs()
    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
  }

  // Every active account in this parish's chart, at 0.00 (server-built).
  const template = async () => {
    try {
      const r = await fetch(apiUrl('/api/finance/cutover/template'))
      if (!r.ok) throw new Error(t('cut.error'))
      const a = document.createElement('a')
      a.href = URL.createObjectURL(await r.blob()); a.download = 'old-system-trial-balance-template.csv'; a.click()
    } catch (err) { toast.error(err.message) }
  }

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50'
  const cardCls = 'rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 shadow-warm p-4 mb-4'
  const btn = 'tap inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium'
  const chip = { match: 'bg-church-100 text-church-800', mismatch: 'bg-rose-100 text-rose-800', missing: 'bg-amber-100 text-amber-900', incomplete: 'bg-amber-100 text-amber-900' }
  const unknown = t('cut.unknown')

  if (!isAdmin) {
    return (
      <PageWrapper type="list">
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState icon={Scale} title={t('fin.adminOnly')} body={t('fin.adminOnlyBody')} />
        </div>
      </PageWrapper>
    )
  }


  return (
    <PageWrapper type="list">
      <div className="mb-5">
        <PageHeader
          title={t('cut.title')}
          leading={<Scale size={20} />}
          subtitle={<>{t('cut.sub')} <Link to="/finance" className="underline">{t('cut.back')}</Link></>}
        />
      </div>

      <section className={cardCls} aria-labelledby="cut-guide">
        <h2 id="cut-guide" className="font-semibold mb-2">{t('cut.guideTitle')}</h2>
        <ol className="list-decimal pl-5 text-sm space-y-1">
          <li>{t('cut.guide1')}</li><li>{t('cut.guide2')}</li><li>{t('cut.guide3')}</li><li>{t('cut.guide4')}</li>
        </ol>
        <button type="button" onClick={template} className={`${btn} mt-3 border border-parchment-300/70`}><FileDown size={15} />{t('cut.template')}</button>
      </section>

      <section className={cardCls}>
        <label className="block text-sm font-medium mb-1" htmlFor="cut-csv">{t('cut.csvLabel')}</label>
        <textarea id="cut-csv" rows={6} value={csv} onChange={e => setCsv(e.target.value)} className={`${inputCls} font-mono`} placeholder="account_code,amount" />
        <div className="flex flex-wrap items-end gap-2 mt-2">
          <label className="text-sm">{t('cut.asOf')}
            <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className={inputCls} aria-label={t('cut.asOf')} />
          </label>
          <button type="button" disabled={busy} onClick={run} className={`${btn} bg-church-700 text-parchment-50`}>{t('cut.run')}</button>
        </div>
      </section>

      {sb && (
        <section className={cardCls} aria-labelledby="cut-board">
          <h2 id="cut-board" className="font-semibold mb-2">{t('cut.boardTitle').replace('{date}', sb.as_of)}</h2>
          <div role="status" className={`rounded-lg px-3 py-2 mb-3 text-sm ${sb.cutover_ready ? chip.match : chip.missing}`}>
            {sb.cutover_ready ? t('cut.ready') : (sb.complete ? t('cut.notReady') : t('cut.incompleteBanner').replace('{n}', String(sb.errors?.length ?? 0)))}
          </div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-ink-500">
              <th>{t('cut.colLine')}</th><th className="text-right">{t('cut.colOld')}</th><th className="text-right">{t('cut.colOc')}</th><th className="text-right">{t('cut.colVar')}</th><th>{t('cut.colStatus')}</th>
            </tr></thead>
            <tbody>
              {sb.lines.map(l => (
                <tr key={l.key} data-testid={`line-${l.key}`} className="border-t border-parchment-300/50">
                  <td className="py-1.5">{t(`cut.line.${l.key}`)}</td>
                  <td className="text-right tabular-nums">{fmtCents(l.old_system_cents) ?? unknown}</td>
                  <td className="text-right tabular-nums">{fmtCents(l.openchurch_cents)}</td>
                  <td className="text-right tabular-nums">{fmtCents(l.variance_cents) ?? unknown}</td>
                  <td><span className={`px-2 py-0.5 rounded-full text-xs ${chip[l.status]}`}>{t(`cut.status.${l.status}`)}</span>
                    {l.status === 'missing' && l.not_in_file?.length > 0 && <span className="text-xs ml-1">{t('cut.notInFileList').replace('{codes}', l.not_in_file.slice(0, 8).join(', '))}</span>}
                    {l.status === 'mismatch' && l.mismatched_accounts > 0 && <span className="text-xs ml-1">{t('cut.accountsOff').replace('{n}', String(l.mismatched_accounts))}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" disabled={busy} onClick={exportCsv} className={`${btn} mt-3 border border-parchment-300/70`}><Download size={15} />{t('cut.export')}</button>

          {sb.cutover_ready && (
            <div className="mt-4 border-t border-parchment-300/50 pt-3">
              <h3 className="font-semibold text-sm mb-1">{t('cut.signTitle')}</h3>
              <p className="text-xs text-ink-500 mb-2">{t('cut.signHelp')}</p>
              <div className="flex flex-wrap gap-2 items-end">
                <label className="text-sm">{t('cut.signName')}<input value={name} onChange={e => setName(e.target.value)} maxLength={200} className={inputCls} /></label>
                <label className="text-sm">{t('cut.signDate')}<input type="date" value={signedOn} onChange={e => setSignedOn(e.target.value)} className={inputCls} /></label>
                <button type="button" disabled={busy} onClick={signOff} className={`${btn} bg-church-700 text-parchment-50`}>{t('cut.signBtn')}</button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className={cardCls} aria-labelledby="cut-history">
        <h2 id="cut-history" className="font-semibold mb-2">{t('cut.historyTitle')}</h2>
        {signoffs === null ? <p className="text-sm">…</p>
          : signoffs === 'error' ? <p role="alert" className="text-sm">{t('cut.historyError')}</p>
          : signoffs.length === 0 ? <p className="text-sm text-ink-500">{t('cut.historyEmpty')}</p>
          : <ul className="text-sm space-y-1">{signoffs.map(s => (
              <li key={s.id}>{t('cut.historyRow').replace('{name}', s.accountant_name).replace('{signed}', String(s.signed_on).slice(0, 10)).replace('{asOf}', String(s.as_of).slice(0, 10)).replace('{by}', s.recorded_by_name || '—')}</li>
            ))}</ul>}
      </section>
    </PageWrapper>
  )
}
