import { useState } from 'react'
import { motion } from 'framer-motion'
import { Upload, Download, X, CheckCircle2, AlertTriangle, Loader2, FileText } from 'lucide-react'
import { apiUrl } from '../api'
import { scrimCls } from './MobileSheet'

// Bulk-import events from a CSV file. Strict schema:
// title, service_division, date, time, location, liturgical_season,
// liturgical_color, feast_name — see TEMPLATE_CSV below for the
// canonical shape. No duplicate detection — events don't have a
// natural unique key (two services on the same day at different
// locations are real), so we trust the admin's file.
//
// Props:
//   onClose:    () => void — user dismissed or finished the import
//   onImported: () => void — fires after a successful import so the
//                            parent can refetch its event list

const TEMPLATE_CSV = `title,service_division,date,time,location,liturgical_season,liturgical_color,feast_name
Sunday Mass,Worship,2026-05-03,10:00,Main Sanctuary,Easter,White,
Wednesday Bible Study,Formation,2026-05-06,19:00,Fellowship Hall,,,
Parish Potluck,Community,2026-05-09,17:30,Parish Hall,,,
Solemnity of the Ascension,Worship,2026-05-14,18:00,Main Sanctuary,Easter,White,Ascension of the Lord
`

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = 'openchurch-events-template.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function ImportEventsModal({ onClose, onImported }) {
  const [file,    setFile]    = useState(null)
  const [csvText, setCsvText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [result,  setResult]  = useState(null)
  const [dragging, setDragging] = useState(false)

  async function handleFile(f) {
    setError('')
    if (!f) return
    const isCsv = /\.csv$/i.test(f.name) || f.type === 'text/csv' || f.type === 'application/vnd.ms-excel'
    if (!isCsv) { setError('Please select a .csv file.'); return }
    try {
      const text = await f.text()
      setFile(f)
      setCsvText(text)
    } catch {
      setError('Could not read that file.')
    }
  }

  async function runImport() {
    if (!csvText) return
    setLoading(true); setError('')
    try {
      const res  = await fetch(apiUrl('/api/events/import'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || `Import failed (${res.status})`)
        return
      }
      setResult(data)
      onImported?.()
    } catch (err) {
      setError(err.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }

  const previewCount = csvText
    ? Math.max(0, csvText.split(/\r?\n/).filter(l => l.trim()).length - 1)
    : 0

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className={`${scrimCls} flex items-center justify-center z-50 p-4`}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-lg bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm-md overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-church-50 dark:bg-church-900/40 flex items-center justify-center text-church-800 dark:text-brass-300">
              <Upload size={17} />
            </div>
            <div>
              <h2 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">
                Import events from CSV
              </h2>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
                Strict schema — download the template if you're starting from scratch.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:text-parchment-400/60 dark:hover:text-parchment-100 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {result ? (
            <div className="space-y-3">
              <div className="flex items-start gap-3 p-4 rounded-xl bg-brass-50 dark:bg-brass-900/20 border border-brass-200/70 dark:border-brass-800/40">
                <CheckCircle2 size={18} className="shrink-0 mt-0.5 text-brass-700 dark:text-brass-300" />
                <div className="flex-1 text-sm">
                  <p className="font-semibold text-ink-800 dark:text-parchment-100">
                    Imported {result.imported} event{result.imported === 1 ? '' : 's'}.
                  </p>
                  <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
                    Members aren't assigned via CSV — open each event to add them.
                  </p>
                </div>
              </div>
              {result.errors?.length > 0 && (
                <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200/70 dark:border-amber-800/40">
                  <div className="flex items-start gap-3">
                    <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-700 dark:text-amber-300" />
                    <div className="flex-1 text-sm">
                      <p className="font-semibold text-ink-800 dark:text-parchment-100">
                        {result.errors.length} row{result.errors.length === 1 ? '' : 's'} could not be imported
                      </p>
                      <ul className="mt-2 space-y-0.5 text-xs text-ink-500 dark:text-parchment-300/70 font-mono">
                        {result.errors.slice(0, 8).map((e, i) => (
                          <li key={i}>Line {e.line}: {e.message}</li>
                        ))}
                        {result.errors.length > 8 && <li>…and {result.errors.length - 8} more.</li>}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="text-sm text-ink-600 dark:text-parchment-300/80 leading-relaxed">
                Columns (in any order): <span className="font-mono text-xs">title, service_division, date, time, location, liturgical_season, liturgical_color, feast_name</span>. Only <span className="font-mono text-xs">title</span> is required. Date is <span className="font-mono text-xs">YYYY-MM-DD</span>; time is <span className="font-mono text-xs">HH:MM</span> (24-hour).
              </div>
              <button
                type="button"
                onClick={downloadTemplate}
                className="inline-flex items-center gap-2 text-xs font-semibold text-church-800 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors"
              >
                <Download size={13} /> Download template CSV
              </button>

              <label
                onDragEnter={e => { e.preventDefault(); setDragging(true) }}
                onDragOver={e => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => {
                  e.preventDefault()
                  setDragging(false)
                  handleFile(e.dataTransfer.files?.[0])
                }}
                className={`flex flex-col items-center justify-center gap-2 px-6 py-8 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${
                  dragging
                    ? 'border-church-500 bg-church-50/60 dark:bg-church-900/20'
                    : 'border-parchment-300/80 dark:border-brass-900/40 bg-parchment-100/50 dark:bg-ink-800/40 hover:border-brass-400 dark:hover:border-brass-700'
                }`}
              >
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={e => handleFile(e.target.files?.[0])}
                />
                {file ? (
                  <>
                    <FileText size={22} className="text-church-800 dark:text-brass-300" />
                    <p className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{file.name}</p>
                    <p className="text-xs text-ink-500 dark:text-parchment-300/70">
                      {previewCount} data row{previewCount === 1 ? '' : 's'} detected
                    </p>
                    <p className="text-xs text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 underline">
                      Choose a different file
                    </p>
                  </>
                ) : (
                  <>
                    <Upload size={22} className="text-ink-400 dark:text-parchment-400/60" />
                    <p className="text-sm font-semibold text-ink-700 dark:text-parchment-100">
                      Drop a CSV here, or click to pick
                    </p>
                    <p className="text-xs text-ink-500 dark:text-parchment-300/70">
                      UTF-8 CSV up to 10 MB
                    </p>
                  </>
                )}
              </label>

              {error && (
                <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-parchment-300/60 dark:border-brass-900/30 bg-parchment-100/40 dark:bg-ink-800/30">
          {result ? (
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-ink-500 hover:text-ink-800 dark:text-parchment-300/70 dark:hover:text-parchment-100 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={runImport}
                disabled={!csvText || loading}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-50"
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                {loading ? 'Importing…' : 'Import'}
              </button>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
