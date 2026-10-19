// SP-052: optionally link a Mass intention's requester to a member of THIS
// parish. The free-text "Requested by" stays; this link is additive.
// The search goes to GET /api/clients/picker, which returns only {id, name}
// for the session's parish (no contact fields are downloaded). The server re-checks the id on save; this picker
// is convenience, not the control.
import { useEffect, useId, useState } from 'react'
import { apiUrl } from '../api'
import { loadList } from '../utils/format'

export default function RequesterMemberLink({ memberId, memberName, onChange, t, inputCls = '' }) {
  const id = useId()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState([])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const term = q.trim()
    if (memberId != null || term.length < 2) { setHits([]); setFailed(false); return undefined }
    let live = true
    const timer = setTimeout(async () => {
      const { ok, data } = await loadList(apiUrl(`/api/clients/picker?${new URLSearchParams({ search: term, limit: '8' })}`))
      if (!live) return
      setFailed(!ok)
      setHits(ok && Array.isArray(data) ? data.filter(m => Number.isInteger(m?.id) && m.id > 0).map(m => ({ id: m.id, name: m.name || '' })) : [])
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [q, memberId])

  if (memberId != null) {
    return (
      <div className="flex items-center gap-2 text-xs mt-1" data-testid="requester-linked">
        <span>{t('mi.linkedMember')} <strong>{memberName || t('mi.linkedMemberUnnamed')}</strong></span>
        <button type="button" className="underline" onClick={() => onChange(null, '')}>{t('mi.unlinkMember')}</button>
      </div>
    )
  }
  return (
    <div className="mt-1">
      <label htmlFor={`${id}-search`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.linkMember')}</label>
      <input id={`${id}-search`} type="search" value={q} onChange={e => setQ(e.target.value)}
        placeholder={t('mi.linkMemberPlaceholder')} className={inputCls} autoComplete="off" />
      {failed && <p role="alert" className="text-xs mt-1">{t('mi.linkMemberFailed')}</p>}
      {hits.length > 0 && (
        <ul className="mt-1 border rounded text-sm" aria-label={t('mi.linkMember')}>
          {hits.map(m => (
            <li key={m.id}>
              <button type="button" className="w-full text-left px-2 py-1" onClick={() => { onChange(m.id, m.name); setQ('') }}>{m.name}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
