// Migration Studio (MIG.1) — the careful move into a new parish office.
//
// One page, four calm steps:
//   Welcome  — what can come over now, what needs its own conversation,
//              what to prepare, and the promise: nothing changes until a
//              person approves it. Plus a quiet source-inventory list
//              (orientation, not a scored checklist) and import history.
//   Columns  — the mapping table: every source column, where it goes (or
//              "leave out", visibly), with sample values alongside.
//   Review   — what's ready, what's held and why, which rows look like
//              records the parish already has (each with its reason), and
//              the person's choices: import anyway, skip, or leave for
//              follow-up.
//   Approve  — the counts restated in one place, and an administrator's
//              explicit commit. Then the receipt.
//
// Constitutional constraints carried in code: preview writes nothing;
// no AI anywhere in this flow; the original file is not stored and the
// copy says so; no progress scores, no pressure language, no red.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { loadOne, loadList } from '../utils/format'
import {
  PackageOpen, Upload, ChevronRight, Loader2, X, ArrowLeft, FileText,
} from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'

// Server messages arrive as { error, code, message: { en, es } }. The
// server does not guess which language to speak — it sends both and the
// reader's own setting chooses. `error` stays as the fallback for any
// response that predates the catalogue.
function serverText(body, locale, fallback) {
  return body?.message?.[locale] ?? body?.message?.en ?? body?.error ?? fallback
}
import { useAuth } from '../context/AuthContext'
import PageWrapper from '../components/PageWrapper'
import { useConfirm } from '../components/ConfirmProvider'
import { isWorkbook, isLegacyWorkbook, readWorkbook, interpretWorkbook } from '../utils/workbook'

const KINDS = ['members', 'funds', 'gifts']

const inputCls = 'w-full rounded-lg border border-parchment-300 dark:border-brass-900/40 bg-white dark:bg-ink-900 px-2.5 py-2 text-sm text-ink-800 dark:text-parchment-100 focus:outline-none focus:ring-2 focus:ring-church-500/40 min-h-[40px]'
const btnPrimary = 'inline-flex items-center justify-center gap-2 rounded-lg bg-church-800 px-4 py-2 text-sm font-medium text-parchment-50 hover:bg-church-900 disabled:opacity-60 dark:bg-brass-700 dark:hover:bg-brass-600 min-h-[44px]'
const btnQuiet = 'inline-flex items-center justify-center gap-2 rounded-lg border border-parchment-300 dark:border-brass-900/40 px-3.5 py-2 text-sm text-ink-700 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800 disabled:opacity-60 min-h-[44px]'
const cardCls = 'rounded-xl border border-parchment-300/70 dark:border-brass-900/30 bg-white/70 dark:bg-ink-800/60'

function SectionLabel({ children }) {
  return <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70 mb-2">{children}</p>
}

const BATCH_TONE = {
  uploaded:  'bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-300/80',
  mapped:    'bg-brass-50 text-brass-700 dark:bg-brass-900/25 dark:text-brass-300',
  committed: 'bg-church-50 text-church-800 dark:bg-church-900/40 dark:text-brass-200',
  abandoned: 'bg-parchment-200 text-ink-500 dark:bg-ink-800 dark:text-parchment-300/70',
}

/* ── Welcome / landing ─────────────────────────────────────────────────── */

function Welcome({ history, historyFailed, retention, onStart, reload }) {
  const { t, locale, dateLocale } = useLocale()
  const [kind, setKind] = useState('members')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(null)
  const fileRef = useRef(null)

  // Staging is the same call whatever the file was. A workbook has
  // already become CSV text by the time it gets here, so there is one
  // upload path, one server contract, one receipt.
  async function stage(sourceName, text) {
    setBusy(true)
    try {
      const r = await fetch(apiUrl('/api/imports'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, source_name: sourceName, csv: text }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(serverText(data, locale, t('mig.uploadError')))
      // The server's deterministic suggestion, kept for the mapping step
      // (session-local; it is a suggestion, never a decision).
      try { sessionStorage.setItem(`ochr_import_sugg_${data.id}`, JSON.stringify(data.suggested_mapping)) } catch { /* fine */ }
      onStart(data.id)
    } catch (e2) {
      setError(e2.message)
    } finally {
      setBusy(false)
    }
  }

  async function pickFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError('')
    setReading(null)

    // .xls and .xlsb are the pre-2007 binary formats. Naming them is
    // kinder than "unsupported file", and the fix — Save As, choose
    // .xlsx — is one sentence long.
    if (isLegacyWorkbook(file)) { setError(t('mig.legacyWorkbook')); return }

    if (isWorkbook(file)) {
      setBusy(true)
      try {
        const sheets = await readWorkbook(file)
        const read = interpretWorkbook(sheets)
        if (!read.ok) {
          setError(read.reason === 'no_data' ? t('mig.workbookNoData') : t('mig.workbookUnreadable'))
          return
        }
        // Straight through when there was nothing to decide and nothing
        // was skipped. Stopping to announce "I read your file correctly"
        // is a screen that teaches the system rather than doing the work.
        if (!read.skipped_above && !read.other_sheets.length) {
          await stage(file.name, read.csv)
          return
        }
        // Otherwise SAY what happened before it happens. Skipping rows and
        // choosing between tabs are changes to their data, and a change
        // they cannot see is one they cannot correct.
        setReading({ file, sheets, read })
      } catch {
        setError(t('mig.workbookUnreadable'))
      } finally {
        setBusy(false)
      }
      return
    }

    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') {
      setError(t('mig.notCsv'))
      return
    }
    await stage(file.name, await file.text())
  }

  // Re-interpret against a different tab, without re-reading the file.
  function chooseSheet(name) {
    const read = interpretWorkbook(reading.sheets, { sheetName: name })
    if (read.ok) setReading(r => ({ ...r, read }))
  }

  const inventory = ['inv1', 'inv2', 'inv3', 'inv4', 'inv5', 'inv6']

  return (
    <div className="space-y-6 max-w-3xl">
      <div className={`${cardCls} p-5 space-y-3`}>
        <p className="text-sm leading-relaxed text-ink-700 dark:text-parchment-200">{t('mig.welcome1')}</p>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <SectionLabel>{t('mig.canImport')}</SectionLabel>
            <ul className="space-y-1 text-sm text-ink-700 dark:text-parchment-200">
              <li>· {t('mig.kind.members')}</li>
              <li>· {t('mig.kind.funds')}</li>
              <li>· {t('mig.kind.gifts')}</li>
            </ul>
          </div>
          <div>
            <SectionLabel>{t('mig.separately')}</SectionLabel>
            <p className="text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80">{t('mig.separatelyBody')}</p>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-ink-700 dark:text-parchment-200 border-t border-parchment-300/60 dark:border-brass-900/30 pt-3">
          {t('mig.promise')}
        </p>
      </div>

      <div className={`${cardCls} p-5`}>
        <SectionLabel>{t('mig.inventoryTitle')}</SectionLabel>
        <p className="text-sm text-ink-600 dark:text-parchment-300/80 mb-3">{t('mig.inventoryIntro')}</p>
        <ul className="space-y-2">
          {inventory.map(k => (
            <li key={k}>
              <label className="flex items-start gap-2.5 text-sm text-ink-700 dark:text-parchment-200">
                <input type="checkbox" className="accent-[#7B2D26] w-4 h-4 mt-0.5" />
                <span>{t(`mig.${k}`)}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className={`${cardCls} p-5 space-y-3`}>
        <SectionLabel>{t('mig.startTitle')}</SectionLabel>
        <p className="text-sm text-ink-600 dark:text-parchment-300/80">{t('mig.startIntro')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-[10px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70 mb-1">{t('mig.whatKind')}</span>
            <select value={kind} onChange={e => setKind(e.target.value)} className={`${inputCls} w-auto`}>
              {KINDS.map(k => <option key={k} value={k}>{t(`mig.kind.${k}`)}</option>)}
            </select>
          </label>
          <button onClick={() => fileRef.current?.click()} disabled={busy} className={btnPrimary}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} {t('mig.chooseFile')}
          </button>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={pickFile} className="sr-only" aria-label={t('mig.chooseFile')} />
        </div>
        <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('mig.fileHelp')}</p>
        <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('mig.fileTruth')}</p>
        {/* The retention policy, said by the server so the copy and the
            prune can never disagree about the number of days. */}
        <p className="text-xs text-ink-500 dark:text-parchment-300/70">
          {retention?.[locale] ?? retention?.en ?? t('mig.retentionFallback')}
        </p>
        {error && <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p>}

        {/* What was read, said before anything is staged. Only appears
            when there was something to say: rows above the headings were
            skipped, or the workbook had more than one tab with data. */}
        {reading && (
          <div className="mt-2 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100/60 dark:bg-ink-900/50 p-4 space-y-3">
            <SectionLabel>{t('mig.readTitle')}</SectionLabel>
            <p className="text-sm text-ink-700 dark:text-parchment-200">
              {t('mig.readSummary', {
                sheet: reading.read.chosen,
                rows: reading.read.data_rows,
                row: reading.read.header_row,
              })}
            </p>
            {reading.read.skipped_above > 0 && (
              <p className="text-sm text-ink-600 dark:text-parchment-300/80">
                {reading.read.skipped_above === 1
                  ? t('mig.readSkipped_one')
                  : t('mig.readSkipped', { count: reading.read.skipped_above })}
              </p>
            )}
            <p className="text-xs text-ink-500 dark:text-parchment-300/70">
              {t('mig.readHeadings', { headings: reading.read.headings.join(' · ') })}
            </p>
            {reading.read.other_sheets.length > 0 && (
              <label className="block">
                <span className="block text-[10px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70 mb-1">
                  {t('mig.readOtherTabs')}
                </span>
                <select
                  value={reading.read.chosen}
                  onChange={e => chooseSheet(e.target.value)}
                  className={`${inputCls} w-auto`}
                >
                  {reading.read.sheets.filter(s => s.usable).map(s => (
                    <option key={s.name} value={s.name}>
                      {t('mig.readTabOption', { name: s.name, rows: s.data_rows })}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                onClick={() => { const r = reading; setReading(null); stage(r.file.name, r.read.csv) }}
                disabled={busy}
                className={btnPrimary}
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : null} {t('mig.readContinue')}
              </button>
              <button
                onClick={() => setReading(null)}
                className="tap-reach text-sm font-medium text-ink-600 dark:text-parchment-300/80 hover:text-church-700 dark:hover:text-brass-300 transition-colors"
              >
                {t('mig.readCancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      {historyFailed && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
          {t('mig.historyFailed')}
        </p>
      )}

      {history.length > 0 && (
        <div>
          <SectionLabel>{t('mig.historyTitle')}</SectionLabel>
          <div className="space-y-2">
            {history.map(b => (
              <div key={b.id} className={`${cardCls} px-4 py-3 flex flex-wrap items-center gap-3`}>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${BATCH_TONE[b.status]}`}>
                  {t(`mig.batch.${b.status}`)}
                </span>
                <span className="flex-1 min-w-0 text-sm text-ink-800 dark:text-parchment-100 truncate">
                  {t(`mig.kind.${b.kind}`)} · {b.source_name}
                  <span className="text-xs text-ink-500 dark:text-parchment-300/70"> · {b.row_count} {t('mig.rows')} · {new Date(b.created_at).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })}</span>
                </span>
                {b.status === 'committed' ? (
                  <Link to={`/migration/${b.id}/receipt`} className="text-xs underline text-church-700 dark:text-brass-300 min-h-[32px] inline-flex items-center">
                    {t('mig.viewReceipt')}
                  </Link>
                ) : b.status !== 'abandoned' ? (
                  <button onClick={() => onStart(b.id)} className="text-xs underline text-church-700 dark:text-brass-300 min-h-[32px]">
                    {t('mig.resume')}
                  </button>
                ) : null}

                {/* The retention notice, and the reason it is shaped this
                    way.

                    It appears ONLY on an unfinished import, because that
                    is the only place the window costs anything: a
                    committed import keeps its receipt forever, and an
                    abandoned one was closed on purpose. Warning about
                    those would be manufacturing a worry to then relieve.

                    It is ALWAYS present on an unfinished import — not at
                    day 23, not when the date is close. A line that is
                    always there is furniture; a line that APPEARS is an
                    alarm, and the difference is the whole constitution.
                    Nothing here counts down, changes colour as the date
                    approaches, or says "expires".

                    And it is phrased as the work, not the loss: what is
                    offered is finishing the import, with the date stated
                    beside it as an ordinary fact. */}
                {b.rows_available && b.rows_available_until && b.status !== 'abandoned' && (
                  <p className="w-full text-xs text-ink-500 dark:text-parchment-300/70">
                    {t('mig.unfinishedKept', { date: b.rows_available_until })}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── The batch workspace (mapping → review → approve) ──────────────────── */

function BatchWorkspace({ batchId, onExit }) {
  const { t, locale } = useLocale()
  const { isAdmin } = useAuth()
  const ask = useConfirm()
  const [batch, setBatch] = useState(null)
  const [mapping, setMapping] = useState({})
  const [samples, setSamples] = useState([])
  const [step, setStep] = useState('mapping') // mapping | review | done
  const [rowsHeld, setRowsHeld] = useState([])
  const [rowsDup, setRowsDup] = useState([])
  const [reviewFailed, setReviewFailed] = useState(false)
  const [reviewLoaded, setReviewLoaded] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState(null)

  const loadBatch = useCallback(async () => {
    const r = await fetch(apiUrl(`/api/imports/${batchId}`))
    if (!r.ok) throw new Error(t('mig.loadError'))
    const b = await r.json()
    setBatch(b)
    if (b.status === 'committed') { setReceipt(b.receipt); setStep('done'); return b }
    if (b.mapping) setMapping(b.mapping)
    else {
      // First visit: ask the server's deterministic suggestion by
      // re-reading sample rows from the row store.
      setMapping(Object.fromEntries(b.headers.map(h => [h, null])))
    }
    if (b.status === 'mapped') setStep('review')
    return b
  }, [batchId, t])

  // "Nothing held, no duplicates" is the sentence that lets an operator
  // commit an import without looking. It must never be produced by a
  // failed request — commit() derives its confirmation counts from these
  // same arrays, so an empty-on-error here silently understates what is
  // about to be written to the parish's records.
  const loadReviewRows = useCallback(async () => {
    const [rh, rd] = await Promise.all([
      loadList(apiUrl(`/api/imports/${batchId}/rows?status=held&limit=200`), d => d.rows),
      loadList(apiUrl(`/api/imports/${batchId}/rows?status=possible_duplicate&limit=200`), d => d.rows),
    ])
    setRowsHeld(rh.data)
    setRowsDup(rd.data)
    setReviewFailed(!rh.ok || !rd.ok)
    // Records that the review was actually READ, not merely that it did not
    // report a failure. `reviewFailed === false` is the initial state as well
    // as the success state, so it cannot by itself authorise a commit.
    setReviewLoaded(rh.ok && rd.ok)
  }, [batchId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const b = await loadBatch()
        if (cancelled) return
        // Sample values for the mapping table. Isolated in its own try, and
        // that isolation is the whole point: this call used to sit directly
        // above the review load inside one try block, so a rejected fetch —
        // or a 200 whose body simply had no `rows` — threw past
        // loadReviewRows(). The review screen then rendered with
        // reviewFailed still false, both row arrays empty, and the commit
        // button enabled. Reproduced 27 Aug by stubbing this one response
        // with `{}`. A cosmetic call must never be able to disarm a guard.
        try {
          const rr = await fetch(apiUrl(`/api/imports/${batchId}/rows?limit=4`))
          if (rr.ok && !cancelled) {
            const body = await rr.json()
            if (Array.isArray(body?.rows)) setSamples(body.rows.map(r => r.raw))
          }
        } catch { /* samples are a convenience; the review below is not */ }

        if (b.status === 'mapped' && !cancelled) await loadReviewRows()
        // A fresh batch starts from the suggestion captured at upload
        // time (session-local); absent that, every column starts as
        // "leave out" and a person chooses.
        if (b.status === 'uploaded' && !b.mapping && !cancelled) {
          try {
            const stored = sessionStorage.getItem(`ochr_import_sugg_${batchId}`)
            if (stored) setMapping(JSON.parse(stored))
          } catch { /* fall through to all-null mapping */ }
        }
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    })()
    return () => { cancelled = true }
  }, [batchId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function applyMapping() {
    setBusy('map'); setError('')
    try {
      const r = await fetch(apiUrl(`/api/imports/${batchId}/mapping`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(serverText(data, locale, t('mig.saveError')))
      await loadBatch()
      await loadReviewRows()
      setStep('review')
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }

  async function decide(rowId, decision) {
    try {
      const r = await fetch(apiUrl(`/api/imports/${batchId}/rows/${rowId}`), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      if (!r.ok) throw new Error(serverText(await r.json().catch(() => ({})), locale, t('mig.saveError')))
      setRowsHeld(rows => rows.map(x => x.id === rowId ? { ...x, decision } : x))
      setRowsDup(rows => rows.map(x => x.id === rowId ? { ...x, decision } : x))
    } catch (e) { setError(e.message) }
  }

  async function commit() {
    // Refuse rather than approve an import whose review we could not read.
    // The button is already disabled; this is the guard that survives a
    // future refactor of the button.
    if (reviewFailed || !reviewLoaded) { setError(t('mig.reviewFailedBody')); return }
    const s = batch.summary || {}
    const dupImport = rowsDup.filter(r => r.decision === 'import').length
    const skippedByHand = [...rowsHeld, ...rowsDup].filter(r => r.decision === 'skip').length
    const ok = await ask({
      title: t('mig.commitTitle'),
      body: t('mig.commitBody', { ready: (s.ready ?? 0) + dupImport - skippedByHand < 0 ? 0 : (s.ready ?? 0) + dupImport }),
      confirmLabel: t('mig.commitConfirm'),
    })
    if (!ok) return
    setBusy('commit'); setError('')
    try {
      const r = await fetch(apiUrl(`/api/imports/${batchId}/commit`), { method: 'POST' })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(serverText(data, locale, t('mig.saveError')))
      setReceipt(data.receipt)
      setStep('done')
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }

  async function abandon() {
    const ok = await ask({ title: t('mig.abandonTitle'), body: t('mig.abandonBody'), confirmLabel: t('mig.abandonConfirm') })
    if (!ok) return
    // Leaving the studio on a failed abandon strands the batch: it stays
    // open server-side, and the screen that would let you finish or discard
    // it is the one you just walked out of. Stay put and say so.
    try {
      const res = await fetch(apiUrl(`/api/imports/${batchId}/abandon`), { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || t('mig.saveError'))
        return
      }
    } catch {
      setError(t('mig.saveError'))
      return
    }
    onExit()
  }

  if (error && !batch) return <p className="text-sm text-rose-700 dark:text-rose-300 py-8" role="alert">{error}</p>
  if (!batch) return <div className="flex justify-center py-16"><Loader2 size={20} className="animate-spin text-brass-600" /></div>

  const s = batch.summary || {}
  const undecidedDups = rowsDup.filter(r => !r.decision).length

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button onClick={onExit} className="inline-flex items-center gap-1.5 text-sm text-church-700 dark:text-brass-300 hover:underline min-h-[40px]">
          <ArrowLeft size={15} /> {t('mig.backToStudio')}
        </button>
        <p className="text-sm text-ink-600 dark:text-parchment-300/80">
          {t(`mig.kind.${batch.kind}`)} · {batch.source_name} · {batch.row_count} {t('mig.rows')}
        </p>
      </div>

      {/* Step: mapping */}
      {step === 'mapping' && (
        <div className={`${cardCls} p-5 space-y-4`}>
          <div>
            <h2 className="font-display text-lg font-semibold text-church-800 dark:text-brass-400">{t('mig.mapTitle')}</h2>
            <p className="text-sm text-ink-600 dark:text-parchment-300/80 mt-1">{t('mig.mapIntro')}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">
                  <th className="py-2 pr-3">{t('mig.colSource')}</th>
                  <th className="py-2 pr-3">{t('mig.colSample')}</th>
                  <th className="py-2">{t('mig.colDest')}</th>
                </tr>
              </thead>
              <tbody>
                {batch.headers.map(h => (
                  <tr key={h} className="border-t border-parchment-200/70 dark:border-brass-900/25 align-top">
                    <td className="py-2.5 pr-3 font-medium text-ink-800 dark:text-parchment-100 whitespace-nowrap">{h}</td>
                    <td className="py-2.5 pr-3 text-xs text-ink-500 dark:text-parchment-300/70 max-w-[12rem]">
                      <span className="line-clamp-2">{samples.map(r0 => r0[h]).filter(Boolean).slice(0, 2).join(' · ') || '—'}</span>
                    </td>
                    <td className="py-2">
                      <select value={mapping[h] ?? ''} aria-label={`${t('mig.colDest')}: ${h}`}
                        onChange={e => setMapping(m => ({ ...m, [h]: e.target.value || null }))}
                        className={`${inputCls} w-auto min-w-[11rem]`}>
                        <option value="">{t('mig.leaveOut')}</option>
                        {batch.fields.map(f => (
                          <option key={f} value={f}>
                            {t(`mig.field.${batch.kind}.${f}`)}{batch.required.includes(f) ? ` (${t('mig.required')})` : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('mig.leaveOutNote')}</p>
          {error && <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p>}
          <div className="flex justify-between gap-2">
            <button onClick={abandon} className={btnQuiet}>{t('mig.abandon')}</button>
            <button onClick={applyMapping} disabled={busy === 'map'} className={btnPrimary}>
              {busy === 'map' && <Loader2 size={14} className="animate-spin" />} {t('mig.applyMapping')}
            </button>
          </div>
        </div>
      )}

      {/* Step: review + approve */}
      {step === 'review' && (
        <>
          <div className={`${cardCls} p-5`}>
            <h2 className="font-display text-lg font-semibold text-church-800 dark:text-brass-400 mb-3">{t('mig.reviewTitle')}</h2>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">{s.ready ?? 0}</p>
                <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('mig.readyCount')}</p>
              </div>
              <div>
                <p className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">{s.held ?? 0}</p>
                <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('mig.heldCount')}</p>
              </div>
              <div>
                <p className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">{s.possible_duplicate ?? 0}</p>
                <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('mig.dupCount')}</p>
              </div>
            </div>
            {s.ignored_columns?.length > 0 && (
              <p className="mt-3 text-xs text-ink-500 dark:text-parchment-300/70">
                {t('mig.ignoredColumns')}: {s.ignored_columns.join(', ')}
              </p>
            )}
            <button onClick={() => setStep('mapping')} className="mt-3 text-xs underline text-church-700 dark:text-brass-300 min-h-[32px]">
              {t('mig.backToMapping')}
            </button>
          </div>

          {(reviewFailed || !reviewLoaded) && (
            <div role="alert" className={`${cardCls} p-5 border-amber-300/70 dark:border-amber-700/40 bg-amber-50/70 dark:bg-amber-900/15`}>
              <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('mig.reviewFailedTitle')}</p>
              <p className="text-sm text-ink-700 dark:text-parchment-200 mt-1">{t('mig.reviewFailedBody')}</p>
              <button onClick={loadReviewRows} className="mt-2 text-xs underline text-church-700 dark:text-brass-300 min-h-[32px]">
                {t('mig.reviewFailedRetry')}
              </button>
            </div>
          )}

          {rowsDup.length > 0 && (
            <div className={`${cardCls} p-5`}>
              <SectionLabel>{t('mig.dupTitle')}</SectionLabel>
              <p className="text-sm text-ink-600 dark:text-parchment-300/80 mb-3">{t('mig.dupIntro')}</p>
              <ul className="space-y-3">
                {rowsDup.map(r => (
                  <li key={r.id} className="border-t border-parchment-200/70 dark:border-brass-900/25 pt-3 first:border-0 first:pt-0">
                    <p className="text-sm text-ink-800 dark:text-parchment-100">
                      {t('mig.rowN', { n: r.row_no })}: {Object.values(r.normalized ?? r.raw).filter(Boolean).slice(0, 3).join(' · ')}
                    </p>
                    <p className="text-xs text-ink-600 dark:text-parchment-300/80 mt-0.5">{r.issue_i18n?.[locale] ?? r.issue}</p>
                    <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label={t('mig.rowN', { n: r.row_no })}>
                      {[['import', 'mig.importAnyway'], ['skip', 'mig.skipRow'], [null, 'mig.leaveForLater']].map(([d, key]) => (
                        <button key={String(d)} onClick={() => decide(r.id, d)}
                          className={`px-2.5 py-1.5 rounded-full text-xs min-h-[32px] border transition-colors ${r.decision === d || (!r.decision && d === null)
                            ? 'bg-church-800 text-parchment-50 border-church-800 dark:bg-brass-700 dark:border-brass-700'
                            : 'bg-white dark:bg-ink-900 text-ink-700 dark:text-parchment-200 border-parchment-300 dark:border-brass-900/40 hover:bg-parchment-100 dark:hover:bg-ink-800'}`}>
                          {t(key)}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rowsHeld.length > 0 && (
            <div className={`${cardCls} p-5`}>
              <SectionLabel>{t('mig.heldTitle')}</SectionLabel>
              <p className="text-sm text-ink-600 dark:text-parchment-300/80 mb-3">{t('mig.heldIntro')}</p>
              <ul className="space-y-3">
                {rowsHeld.map(r => (
                  <li key={r.id} className="border-t border-parchment-200/70 dark:border-brass-900/25 pt-3 first:border-0 first:pt-0">
                    <p className="text-sm text-ink-800 dark:text-parchment-100">
                      {t('mig.rowN', { n: r.row_no })}: {Object.values(r.raw).filter(Boolean).slice(0, 3).join(' · ') || '—'}
                    </p>
                    <p className="text-xs text-ink-600 dark:text-parchment-300/80 mt-0.5">{r.issue_i18n?.[locale] ?? r.issue}</p>
                    <div className="mt-1.5">
                      <button onClick={() => decide(r.id, r.decision === 'skip' ? null : 'skip')}
                        className={`px-2.5 py-1.5 rounded-full text-xs min-h-[32px] border transition-colors ${r.decision === 'skip'
                          ? 'bg-church-800 text-parchment-50 border-church-800 dark:bg-brass-700 dark:border-brass-700'
                          : 'bg-white dark:bg-ink-900 text-ink-700 dark:text-parchment-200 border-parchment-300 dark:border-brass-900/40 hover:bg-parchment-100 dark:hover:bg-ink-800'}`}>
                        {r.decision === 'skip' ? t('mig.skipped') : t('mig.skipRow')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-500 dark:text-parchment-300/70">{t('mig.heldNote')}</p>
            </div>
          )}

          <div className={`${cardCls} p-5 space-y-3`}>
            <SectionLabel>{t('mig.approveTitle')}</SectionLabel>
            <p className="text-sm leading-relaxed text-ink-700 dark:text-parchment-200">
              {t('mig.approveBody', {
                ready: s.ready ?? 0,
                held: (s.held ?? 0) + undecidedDups,
              })}
            </p>
            {error && <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p>}
            <div className="flex flex-wrap justify-between gap-2">
              <button onClick={abandon} className={btnQuiet}>{t('mig.abandon')}</button>
              {isAdmin ? (
                <button onClick={commit} disabled={busy === 'commit' || reviewFailed || !reviewLoaded} className={btnPrimary}>
                  {busy === 'commit' && <Loader2 size={14} className="animate-spin" />} {t('mig.commit')}
                </button>
              ) : (
                <p className="text-sm italic text-ink-600 dark:text-parchment-300/80 self-center">{t('mig.adminOnly')}</p>
              )}
            </div>
          </div>
        </>
      )}

      {/* Step: done — the receipt summary */}
      {step === 'done' && receipt && (
        <div className={`${cardCls} p-5 space-y-3`}>
          <h2 className="font-display text-lg font-semibold text-church-800 dark:text-brass-400">{t('mig.doneTitle')}</h2>
          <p className="text-sm leading-relaxed text-ink-700 dark:text-parchment-200">
            {t('mig.doneBody', { imported: receipt.imported, held: receipt.held_for_follow_up + receipt.duplicates_left_for_review })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link to={`/migration/${batchId}/receipt`} className={btnPrimary}>
              <FileText size={15} /> {t('mig.viewReceipt')}
            </Link>
            <button onClick={onExit} className={btnQuiet}>{t('mig.backToStudio')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Page shell ────────────────────────────────────────────────────────── */

export default function MigrationStudio() {
  const { t } = useLocale()
  const [params, setParams] = useSearchParams()
  const batchId = params.get('batch')
  const [history, setHistory] = useState([])
  const [historyFailed, setHistoryFailed] = useState(false)
  // The retention sentence comes from the server, in both languages, so
  // the copy on this page and the job that actually removes the rows can
  // never disagree about how long "a while" is.
  const [retention, setRetention] = useState(null)

  const loadHistory = useCallback(() => {
    // An empty history section is a claim: "you have not imported anything."
    // If the call failed we do not know that, so the page says so instead of
    // quietly rendering nothing.
    loadOne(apiUrl('/api/imports?limit=20')).then(({ ok, data }) => {
      setHistory(Array.isArray(data?.batches) ? data.batches : [])
      setRetention(data?.retention ?? null)
      setHistoryFailed(!ok)
    })
  }, [])
  useEffect(() => { if (!batchId) loadHistory() }, [batchId, loadHistory])

  return (
    <PageWrapper>
      <div className="mb-5">
        <h1 className="font-display text-2xl font-semibold text-church-900 dark:text-parchment-50">{t('mig.title')}</h1>
        <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-0.5">{t('mig.subtitle')}</p>
      </div>
      {batchId ? (
        <BatchWorkspace batchId={batchId} onExit={() => setParams({})} />
      ) : (
        <Welcome history={history} historyFailed={historyFailed} retention={retention} reload={loadHistory}
          onStart={(id) => setParams({ batch: String(id) })} />
      )}
    </PageWrapper>
  )
}
