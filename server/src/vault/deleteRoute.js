// One Express handler for every protected delete.
//
// Six routes doing capture-then-delete by hand is six chances for one of
// them to quietly go back to a bare DELETE during a later edit. One
// handler means the protection is a property of the route table, visible
// in a single grep, and a new protected kind is one line.
//
// The response stays 204. Recoverability is something the parish learns
// from the Archive & Recovery view and from the confirmation it clicked
// through — not from a body on a delete that nothing reads. A delete that
// started answering 200 with a payload would also be a delete that
// quietly broke every caller checking for 204.

import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'
import { captureAndDelete, VaultError } from './index.js'
import { PROTECTED } from './registry.js'

export function protectedDelete(kind, { notFound, failure, before = null } = {}) {
  const spec = PROTECTED[kind]
  if (!spec) throw new Error(`protectedDelete: ${kind} is not in the vault registry`)

  return async function protectedDeleteHandler(req, res) {
    const id = requireIntParam(req, res); if (id === null) return
    try {
      // Some deletes have work that must happen while the row's id still
      // resolves — cancelling queued reminders, for instance.
      if (before) await before(req, id)

      const result = await captureAndDelete({
        kind, id,
        orgId: req.organizationId,
        user: req.user,
        reason: typeof req.query.reason === 'string' ? req.query.reason.slice(0, 500) : null,
      })
      if (!result) return res.status(404).json({ error: notFound || 'Not found' })
      res.status(204).end()
    } catch (err) {
      if (err instanceof VaultError) {
        return res.status(err.status).json({ error: err.message, code: err.code })
      }
      monitor.error(`vault.delete.${kind}`, err, { orgId: req.organizationId, id })
      res.status(500).json({ error: failure || `Failed to delete ${spec.noun}` })
    }
  }
}
