// Archive & Recovery — the parish's view of what a deletion did not
// destroy.
//
//   GET  /api/vault              → what is recoverable right now
//   GET  /api/vault/:id          → what exactly would come back
//   POST /api/vault/:id/restore  → put it back (admin)
//
// Reading is open to anyone who can already see the records; restoring is
// admin-only. That asymmetry is deliberate: a volunteer who deleted the
// wrong member should be able to see that it is recoverable and say so,
// without being able to reverse an intentional removal somebody else
// decided on.
//
// The list is deliberately calm. It is a record of work that can be
// undone, not a warning panel — nothing here counts down, turns red, or
// invites browsing for something to restore.

import { Router } from 'express'
import { requireRole } from '../middleware/auth.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'
import { listEntries, getEntry, restoreEntry, VaultError } from '../vault/index.js'
import { PROTECTED, RETENTION_DAYS } from '../vault/registry.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const entries = await listEntries(req.organizationId, {
      kind: PROTECTED[req.query.kind] ? req.query.kind : null,
      includeRestored: req.query.include_restored === 'true',
    })
    res.json({
      entries,
      retention_days: RETENTION_DAYS,
      protected_kinds: Object.entries(PROTECTED).map(([kind, s]) => ({ kind, noun: s.noun })),
    })
  } catch (err) {
    monitor.error('vault.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the archive' })
  }
})

router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const entry = await getEntry(req.organizationId, id)
    if (!entry) return res.status(404).json({ error: 'Not found' })
    // The snapshot itself is the parish's own data, but it is a whole
    // deleted record and its children; send the shape, not the payload,
    // unless somebody asks for the full thing.
    const { snapshot, ...rest } = entry
    res.json({
      entry: rest,
      would_restore: {
        record: entry.label,
        // A series is many records, not one with children. Saying "1
        // record and 25 related rows" would describe a shape the parish
        // never had.
        records: snapshot?.roots?.length ?? 1,
        related_rows: snapshot?.cascaded?.length ?? 0,
        reconnections: (snapshot?.relinks ?? []).reduce((a, r) => a + r.ids.length, 0),
        // What a restore will NOT put back, where the kind has something
        // honest to say about it.
        caveat: PROTECTED[entry.kind]?.caveat ?? null,
      },
    })
  } catch (err) {
    monitor.error('vault.get', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load that entry' })
  }
})

router.post('/:id/restore', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const result = await restoreEntry({ entryId: id, orgId: req.organizationId, user: req.user })
    if (!result) return res.status(404).json({ error: 'Not found' })
    res.json(result)
  } catch (err) {
    if (err instanceof VaultError) return res.status(err.status).json({ error: err.message, code: err.code })
    monitor.error('vault.restore', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to restore that record' })
  }
})

export default router
