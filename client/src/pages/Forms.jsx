import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  FileText, Plus, X, Pencil, Trash2, AlertTriangle, ChevronUp, ChevronDown,
  Copy, ExternalLink, Eye, EyeOff,
} from 'lucide-react'
import PageWrapper, { PageHeader } from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { SkeletonRowList } from '../components/Skeleton'
import TextField from '../components/TextField'
import SaveButton, { useSaveStatus } from '../components/SaveButton'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip } from '../components/MobileSheet'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { useConfirm } from '../components/ConfirmProvider'
import { dialogMotionNow } from '../utils/motion'

// Forms admin page (Sprint Forms / F.2). List + create/edit modal +
// FieldBuilder. Admin-only — both this route and /api/forms gate on
// admin.
//
// Visual shape mirrors Pledges: header with primary CTA, summary
// counts, then a single list of rows with inline action buttons.
//
// FieldBuilder uses arrow buttons (not drag) for reorder — keeps the
// bundle small (no react-dnd / dnd-kit) and arrow buttons are more
// keyboard- and mobile-friendly than a drag handle anyway. Reorder
// happens locally in component state; the parent only sees the new
// fields[] array on each change.

// Mirrors FIELD_TYPES in server/src/routes/forms.js. Keep in sync
// when adding a type.
const FIELD_TYPE_OPTIONS = [
  { value: 'short_text',  label: 'Short text',  needsOptions: false },
  { value: 'long_text',   label: 'Long text',   needsOptions: false },
  { value: 'email',       label: 'Email',       needsOptions: false },
  { value: 'number',      label: 'Number',      needsOptions: false },
  { value: 'date',        label: 'Date',        needsOptions: false },
  { value: 'select',      label: 'Dropdown',    needsOptions: true  },
  { value: 'multiselect', label: 'Multi-select', needsOptions: true },
  { value: 'checkbox',    label: 'Checkbox',    needsOptions: false },
]

const FIELD_TYPE_MAP = new Map(FIELD_TYPE_OPTIONS.map(t => [t.value, t]))

const STATUS_PILL = {
  draft:  'bg-parchment-200 text-ink-700 dark:bg-ink-800/40 dark:text-parchment-200',
  open:   'bg-brass-100 text-brass-700 dark:bg-brass-900/30 dark:text-brass-300',
  closed: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200',
}

// Slugify mirrors the server-side helper in server/src/routes/forms.js
// — kept local so the live URL preview reflects the slug the server
// would store, without a round trip.
function slugify(s) {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

// Auto-generated field id for newly-added fields. Time + entropy so a
// fast click-spamming admin never collides ids in the same session.
function generateFieldId() {
  return `field_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

// Pre-flight validator that mirrors the server's validateFieldSchema.
// Running this client-side catches the obvious cases (missing label,
// duplicate keys, empty options) before the round trip so the admin
// gets immediate feedback instead of a toast after Save.
function validateFieldsClient(fields, t) {
  if (fields.length === 0) return t('forms.needField')
  const seenIds = new Set()
  const seenLabels = new Set()
  for (const f of fields) {
    if (!f.id?.trim())    return t('forms.needKey')
    if (seenIds.has(f.id)) return `Duplicate field key: ${f.id}`
    seenIds.add(f.id)
    if (!f.label?.trim()) return t('forms.needLabel')
    const labelKey = f.label.trim().toLowerCase()
    if (seenLabels.has(labelKey)) return `Duplicate field label: ${f.label}`
    seenLabels.add(labelKey)
    // The UI only offers known types via the <select>, but a stale
    // form payload or a future bug elsewhere could leak a bad type
    // through. Catch it here so it surfaces locally instead of as a
    // server 400 the admin has to decode.
    if (!FIELD_TYPE_MAP.has(f.type)) {
      return `Field "${f.label}" has an unknown type: ${f.type}`
    }
    if (FIELD_TYPE_MAP.get(f.type).needsOptions) {
      const opts = (f.options || []).map(o => o.trim()).filter(Boolean)
      if (opts.length === 0) return `Field "${f.label}" needs at least one option.`
    }
  }
  return null
}

function FieldRow({ field, first, last, onChange, onRemove, onMoveUp, onMoveDown }) {
  const { t } = useLocale()
  const typeMeta = FIELD_TYPE_MAP.get(field.type) ?? FIELD_TYPE_OPTIONS[0]
  return (
    <div className="rounded-xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-100/40 dark:bg-ink-900/60 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-[1fr,140px] gap-2">
          <TextField
            label={t('forms.label')}
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder={t('forms.labelPh')}
          />
          <div>
            <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">{t('forms.type')}</label>
            <select
              value={field.type}
              onChange={(e) => {
                const newType = e.target.value
                const needsOptions = FIELD_TYPE_MAP.get(newType)?.needsOptions
                // Drop the options array when switching to a type
                // that doesn't use it — otherwise stale options live
                // on in the JSONB shape forever, which is harmless
                // but dead data and confusing to a later admin.
                onChange({ type: newType, ...(needsOptions ? {} : { options: undefined }) })
              }}
              className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
            >
              {FIELD_TYPE_OPTIONS.map(ft => <option key={ft.value} value={ft.value}>{t('forms.ft.' + ft.value)}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-1 shrink-0 pt-6">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={first}
            aria-label={t('forms.moveUp')}
            className="p-1.5 rounded text-ink-400 hover:text-church-700 dark:hover:text-brass-200 hover:bg-parchment-200 dark:hover:bg-ink-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={last}
            aria-label={t('forms.moveDown')}
            className="p-1.5 rounded text-ink-400 hover:text-church-700 dark:hover:text-brass-200 hover:bg-parchment-200 dark:hover:bg-ink-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronDown size={14} />
          </button>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('forms.removeField')}
          className="shrink-0 p-1.5 mt-6 rounded text-ink-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <TextField
          label={t('forms.key')}
          value={field.id}
          onChange={(e) => onChange({ id: e.target.value })}
          placeholder={t('forms.keyPh')}
          hint="Stored on the response as answers[key]."
        />
        <TextField
          label={t('forms.helpText')}
          value={field.help_text ?? ''}
          onChange={(e) => onChange({ help_text: e.target.value })}
          placeholder={t('forms.optional')}
        />
      </div>

      {typeMeta.needsOptions && (
        <div>
          <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">{t('forms.options')}</label>
          <textarea
            value={(field.options ?? []).join('\n')}
            onChange={(e) => onChange({ options: e.target.value.split('\n') })}
            rows={4}
            placeholder={t('forms.optionsPh')}
            className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-brass-400 resize-none font-mono"
          />
          <p className="mt-1 text-[11px] text-ink-500 dark:text-parchment-300/70">
            {t('forms.optionsHelp')}
          </p>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-ink-700 dark:text-parchment-200 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={Boolean(field.required)}
          onChange={(e) => onChange({ required: e.target.checked })}
          className="rounded border-parchment-400 text-brass-600 focus:ring-brass-400"
        />
        {t('forms.required')}
      </label>
    </div>
  )
}

function FieldBuilder({ fields, onChange }) {
  const { t } = useLocale()
  function update(i, patch) {
    onChange(fields.map((f, idx) => idx === i ? { ...f, ...patch } : f))
  }
  function remove(i) {
    onChange(fields.filter((_, idx) => idx !== i))
  }
  function move(i, dir) {
    const j = i + dir
    if (j < 0 || j >= fields.length) return
    const next = [...fields]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  function add() {
    onChange([
      ...fields,
      { id: generateFieldId(), type: 'short_text', label: '', required: false, options: [] },
    ])
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">
          Fields ({fields.length})
        </label>
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-parchment-100 dark:bg-ink-800 hover:bg-parchment-200 dark:hover:bg-ink-700 text-xs font-semibold text-ink-700 dark:text-parchment-100 transition-colors"
        >
          <Plus size={12} /> {t('forms.add_field')}
        </button>
      </div>
      {fields.length === 0 ? (
        <p className="text-sm text-ink-500 dark:text-parchment-300/70 text-center py-6 rounded-xl border border-dashed border-parchment-300 dark:border-brass-900/30">
          {t('forms.no_fields_yet_add_one')}
        </p>
      ) : (
        fields.map((f, i) => (
          <FieldRow
            key={f.id}
            field={f}
            first={i === 0}
            last={i === fields.length - 1}
            onChange={(patch) => update(i, patch)}
            onRemove={() => remove(i)}
            onMoveUp={() => move(i, -1)}
            onMoveDown={() => move(i, 1)}
          />
        ))
      )}
    </div>
  )
}

function FormModal({ form, orgSlug, onClose, onSaved }) {
  const { t } = useLocale()
  const isEdit = !!form
  const toast = useToast()
  const ask = useConfirm()

  // slugDirty tracks whether the admin has explicitly typed in the
  // slug field. Until then the slug auto-derives from the title so a
  // new form gets a sensible default; once they touch it we stop
  // overwriting their input.
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [draft, setDraft] = useState(() => ({
    title:       form?.title ?? '',
    description: form?.description ?? '',
    slug:        form?.slug ?? '',
    is_public:   form?.is_public ?? false,
    status:      form?.status ?? 'draft',
    fields:      form?.fields ?? [],
  }))

  // Always slugify the preview source — even when the admin typed an
  // explicit slug — so the URL preview matches what the server will
  // actually store. Without this, "Hello World!" in the slug field
  // would show "…/forms/Hello World!" in the preview but resolve to
  // "…/forms/hello-world" once saved.
  const previewSlug = draft.slug ? slugify(draft.slug) : slugify(draft.title)
  const publicUrl = orgSlug && previewSlug
    ? `${window.location.origin}/p/${orgSlug}/forms/${previewSlug}`
    : null
  const isLive = draft.status === 'open' && draft.is_public

  function setTitle(e) {
    const title = e.target.value
    setDraft(prev => ({
      ...prev,
      title,
      slug: slugDirty ? prev.slug : slugify(title),
    }))
  }
  function setSlug(e) {
    const value = e.target.value
    // Clearing the slug field (including whitespace-only) resets the
    // dirty flag AND immediately re-derives from the current title —
    // otherwise the field looks editable but staying empty silently
    // ignores the change on save (the PATCH sends slug:undefined
    // which leaves the existing value alone).
    if (value.trim() === '') {
      setSlugDirty(false)
      setDraft(prev => ({ ...prev, slug: slugify(prev.title) }))
    } else {
      setSlugDirty(true)
      setDraft(prev => ({ ...prev, slug: value }))
    }
  }

  const { status: saveStatus, run: save } = useSaveStatus(async () => {
    if (!draft.title.trim()) throw new Error(t('forms.titleRequired'))
    // Normalize options: trim each, drop blanks. Pre-flight match the
    // shape the server expects so a successful round trip writes the
    // same data the admin saw.
    const cleanedFields = draft.fields.map(f => ({
      id:        f.id?.trim(),
      type:      f.type,
      label:     f.label?.trim(),
      required:  Boolean(f.required),
      help_text: f.help_text?.trim() || undefined,
      ...(FIELD_TYPE_MAP.get(f.type)?.needsOptions
        ? { options: (f.options || []).map(o => o.trim()).filter(Boolean) }
        : {}),
    }))
    const validationError = validateFieldsClient(cleanedFields, t)
    // Open + empty fields is allowed by the validator for drafts, but
    // the server rejects it for status='open'. Surface the rule here
    // so the admin doesn't have to discover it from a 400.
    if (validationError && (draft.status === 'open' || cleanedFields.length > 0)) {
      throw new Error(validationError)
    }

    const payload = {
      title:       draft.title.trim(),
      description: draft.description?.trim() || null,
      slug:        (draft.slug || '').trim() || undefined,
      is_public:   draft.is_public,
      status:      draft.status,
      fields:      cleanedFields,
    }
    const url    = isEdit ? `/api/forms/${form.id}` : '/api/forms'
    const method = isEdit ? 'PATCH' : 'POST'
    const res = await fetch(apiUrl(url), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || t('forms.saveFailed'))
    }
    return res.json()
  }, {
    onSuccess: () => { onSaved(); onClose() },
  })

  return (
    <div className={sheetOverlayCls}>
      <motion.div {...dialogMotionNow()}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
          <h2 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">
            {isEdit ? t('forms.edit') : t('forms.new')}
          </h2>
          <button type="button" onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors">
            <X size={18} />
          </button>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); save().catch(err => toast.error(err.message)) }}
          className="p-6 space-y-5 overflow-y-auto"
        >
          <TextField
            label={t('forms.formTitle')}
            required
            value={draft.title}
            onChange={setTitle}
            placeholder={t('forms.formTitlePh')}
          />

          <div>
            <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">{t('forms.description')}</label>
            <textarea
              value={draft.description}
              onChange={(e) => setDraft(prev => ({ ...prev, description: e.target.value }))}
              rows={2}
              placeholder={t('forms.introPh')}
              className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-brass-400 resize-none"
            />
          </div>

          <div>
            <TextField
              label={t('forms.slug')}
              value={draft.slug}
              onChange={setSlug}
              placeholder={t('forms.slugPh')}
              hint="Auto-derived from the title until you edit it."
            />
            {publicUrl && (
              <p className={`mt-1.5 text-[11px] break-all ${isLive ? 'text-ink-600 dark:text-parchment-300' : 'text-ink-400 dark:text-parchment-400/60 italic'}`}>
                {isLive ? 'Live at' : 'Will be live at'}{' '}
                <span className="font-mono">{publicUrl}</span>
                {!isLive && ' (once status is Open and Public is on)'}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">{t('forms.status')}</label>
              <select
                value={draft.status}
                onChange={(e) => setDraft(prev => ({ ...prev, status: e.target.value }))}
                className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
              >
                <option value="draft">{t('forms.draft')}</option>
                <option value="open">{t('forms.open')}</option>
                <option value="closed">{t('forms.closed')}</option>
              </select>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-ink-600 dark:text-parchment-200">{t('forms.visibility')}</span>
              <span className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.is_public}
                  onChange={(e) => setDraft(prev => ({ ...prev, is_public: e.target.checked }))}
                  className="rounded border-parchment-400 text-brass-600 focus:ring-brass-400"
                />
                <span className="text-sm text-ink-900 dark:text-parchment-50">{t('forms.public')}</span>
              </span>
            </label>
          </div>

          <FieldBuilder
            fields={draft.fields}
            onChange={(next) => setDraft(prev => ({ ...prev, fields: next }))}
          />

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-parchment-300/60 dark:border-brass-900/25">
            <button type="button" onClick={onClose} className="text-sm text-ink-600 dark:text-parchment-300 hover:text-ink-900 dark:hover:text-parchment-50 px-3 py-2">
              {t('forms.cancel')}
            </button>
            <SaveButton status={saveStatus}>{isEdit ? t('forms.save') : t('forms.create')}</SaveButton>
          </div>
        </form>
      </motion.div>
    </div>
  )
}

export default function Forms() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const orgSlug = user?.organization?.slug ?? null
  const toast   = useToast()
  const { t }   = useLocale()
  // `ask` was referenced by removeForm() and never declared in this component
  // — the confirm dialog threw a ReferenceError instead of opening. Found by
  // client-scope 27 Aug once it became function-scoped.
  const ask     = useConfirm()

  const [forms, setForms]   = useState(null)
  const [loading, setLoad]  = useState(true)
  const [err, setErr]       = useState('')
  const [modal, setModal]   = useState(null)   // null | 'new' | form object

  const load = useCallback(() => {
    if (!isAdmin) return
    setLoad(true)
    fetch(apiUrl('/api/forms'))
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Failed (${r.status})`)))
      .then(d => setForms(d.forms ?? []))
      .catch(() => setErr(t('form.loadFailBody')))
      .finally(() => setLoad(false))
  }, [isAdmin, t])

  useEffect(() => { load() }, [load])

  async function removeForm(f) {
    if (!(await ask({
      // The old copy said the responses "will be removed with it" and
      // stopped there, which was the whole truth right up until the
      // Continuity Vault shipped. They are removed AND kept, and the
      // person about to click is exactly who needs to know that.
      title: `Remove “${f.title}”?`,
      body: `The ${f.response_count} response${f.response_count === 1 ? '' : 's'} people have sent come off the form with it.`,
      confirmLabel: t('forms.remove'),
      recoverable: true,
    }))) return
    try {
      const res = await fetch(apiUrl(`/api/forms/${f.id}`), { method: 'DELETE' })
      if (!res.ok) throw new Error(`Delete failed (${res.status})`)
      toast.info(t('forms.deleted'))
      load()
    } catch (e) {
      toast.error(t('forms.deleteFailed'))
    }
  }

  function publicUrlFor(f) {
    if (!orgSlug) return null
    return `${window.location.origin}/p/${orgSlug}/forms/${f.slug}`
  }

  async function copyLink(f) {
    const url = publicUrlFor(f)
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      toast.info(t('forms.copied'))
    } catch {
      toast.error(t('forms.copyFailed'))
    }
  }

  const totals = useMemo(() => {
    if (!forms) return { total: 0, live: 0, responses: 0 }
    return {
      total:     forms.length,
      live:      forms.filter(f => f.status === 'open' && f.is_public).length,
      responses: forms.reduce((s, f) => s + (f.response_count || 0), 0),
    }
  }, [forms])

  if (!isAdmin) {
    return (
      <PageWrapper type="list">
        <div className="max-w-2xl mx-auto space-y-6 py-8">
          <PageHeader title={t('forms.title')} subtitle={t('forms.subtitle')} />
          <EmptyState
            icon={AlertTriangle}
            title={t('forms.adminsOnly')}
            body={t('forms.adminsOnlyBody')}
          />
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper type="list">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4"
        >
          <PageHeader title={t('forms.title')} subtitle={t('forms.subtitle')} />
          <button
            type="button"
            onClick={() => setModal('new')}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-church-900 hover:bg-church-800 text-parchment-50 text-sm font-semibold shadow-sm transition-colors"
          >
            <Plus size={16} /> {t('forms.new')}
          </button>
        </motion.div>

        {/* Summary card */}
        {!loading && (forms?.length ?? 0) > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 shadow-warm p-5 grid grid-cols-3 gap-4 sm:max-w-2xl"
          >
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">{t('forms.total')}</p>
              <p className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 mt-1">{totals.total}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">{t('forms.live')}</p>
              <p className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 mt-1">{totals.live}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">{t('forms.responses')}</p>
              <p className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 mt-1">{totals.responses}</p>
            </div>
          </motion.div>
        )}

        {/* Body */}
        {loading ? (
          <SkeletonRowList count={4} />
        ) : err ? (
          <EmptyState
            icon={AlertTriangle}
            title={t('form.loadFailTitle')}
            body={err}
            action={{ label: 'Retry', onClick: load }}
          />
        ) : (forms?.length ?? 0) === 0 ? (
          <EmptyState
            icon={FileText}
            title={t('forms.emptyTitle')}
            body={t('forms.emptyBody')}
            action={{ label: t('forms.new'), onClick: () => setModal('new') }}
          />
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 overflow-hidden"
          >
            <ul className="divide-y divide-parchment-200/60 dark:divide-brass-900/25">
              {forms.map(f => {
                const live = f.status === 'open' && f.is_public
                const url  = publicUrlFor(f)
                return (
                  <li key={f.id} className="px-5 py-4 flex items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">
                          {f.title}
                        </p>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_PILL[f.status]}`}>
                          {f.status}
                        </span>
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1 bg-parchment-100 text-ink-600 dark:bg-ink-800/40 dark:text-parchment-200">
                          {f.is_public
                            ? <><Eye size={10} /> Public</>
                            : <><EyeOff size={10} /> {t('forms.private')}</>}
                        </span>
                      </div>
                      <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5 truncate">
                        /{f.slug} ·{' '}
                        <Link
                          to={`/forms/${f.id}/responses`}
                          className="hover:text-church-700 dark:hover:text-brass-200 hover:underline transition-colors"
                        >
                          {f.response_count} response{f.response_count === 1 ? '' : 's'}
                        </Link>
                      </p>
                    </div>
                    {live && url && (
                      <div className="hidden sm:flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => copyLink(f)}
                          aria-label={t('forms.copyLink')}
                          title={t('forms.copy_public_link')}
                          className="p-2 rounded-lg text-ink-400 hover:text-church-700 dark:hover:text-brass-200 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors"
                        >
                          <Copy size={14} />
                        </button>
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={t('forms.openTab')}
                          title={t('forms.open_public_form_in_new')}
                          className="p-2 rounded-lg text-ink-400 hover:text-church-700 dark:hover:text-brass-200 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors"
                        >
                          <ExternalLink size={14} />
                        </a>
                      </div>
                    )}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => setModal(f)}
                        aria-label={t('forms.edit')}
                        className="p-2 rounded-lg text-ink-400 hover:text-church-700 dark:hover:text-brass-200 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeForm(f)}
                        aria-label={t('forms.delete')}
                        className="p-2 rounded-lg text-ink-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </motion.div>
        )}
      </div>

      <AnimatePresence>
        {modal && (
          <FormModal
            form={modal === 'new' ? null : modal}
            orgSlug={orgSlug}
            onClose={() => setModal(null)}
            onSaved={load}
          />
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}
