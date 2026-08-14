// Audit-log middleware. Records every successful mutation on a route
// to ochr_audit_log so admins have a "who changed what" history.
//
// Mounted per router so the entity_type label is explicit (URL-based
// inference breaks for /api/calendar vs /api/calendar-sync). Mount it
// AFTER requireAuth + writeGate so the failure cases (401, 403) never
// reach the audit write.
//
// Implementation notes:
//   - The actual write is fired from res.on('finish') so the user's
//     response is never delayed by the audit pipeline.
//   - The write is wrapped in try/catch — an audit failure must not
//     surface to the user. We log to stderr instead.
//   - Only 2xx responses produce a row. 4xx/5xx are not "actions
//     taken" — viewers hitting 403 don't deserve a history entry.

import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

function actionFor(method) {
  if (method === 'POST') return 'create'
  if (method === 'DELETE') return 'delete'
  return 'update'
}

// Build a short human-readable summary. Prefers fields people would
// recognize ("name" for members, "title" for events/tasks). Falls back
// to "<entity> #<id>" when no identifying string is around.
function buildSummary(entityType, action, body, params) {
  const handle =
    body?.name ||
    body?.title ||
    body?.donor_name ||
    null
  const id = params?.id ?? body?.id ?? null
  if (action === 'create' && handle) return `Created ${entityType}: ${handle}`
  if (action === 'create')           return `Created ${entityType}`
  if (action === 'update' && handle) return `Updated ${entityType}: ${handle}`
  if (action === 'update')           return `Updated ${entityType}${id ? ` #${id}` : ''}`
  if (action === 'delete')           return `Deleted ${entityType}${id ? ` #${id}` : ''}`
  return `${action} ${entityType}`
}

// Sanitize the request body before persisting to metadata. Strips
// password fields and large blobs so the audit table stays small and
// safe (no plaintext passwords, no megabyte-sized CSV imports).
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(body)) {
    if (/password|token|secret/i.test(k)) continue
    if (typeof v === 'string' && v.length > 500) {
      out[k] = `${v.slice(0, 500)}…` // truncate, keep the column tidy
      continue
    }
    out[k] = v
  }
  return out
}

export function auditLog(entityType) {
  return function auditLogMiddleware(req, res, next) {
    if (!MUTATING_METHODS.has(req.method)) return next()

    // Capture the response body via a thin res.json wrap. Many of our
    // routes return the new resource on POST so we can recover an
    // entity_id even when there's no :id in the params.
    let responseBody = null
    const origJson = res.json.bind(res)
    res.json = (body) => { responseBody = body; return origJson(body) }

    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return
      if (!req.user?.id || !req.organizationId) return

      const action = actionFor(req.method)
      const entityId = req.params?.id ?? responseBody?.id ?? null
      const summary = buildSummary(entityType, action, responseBody ?? req.body, req.params)
      const metadata = action === 'delete' ? {} : sanitizeBody(req.body)

      pool.query(
        `INSERT INTO ochr_audit_log
           (organization_id, user_id, user_email, user_name, action, entity_type,
            entity_id, summary, metadata, request_method, request_path,
            status_code, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          req.organizationId,
          req.user.id,
          req.user.email ?? null,
          req.user.name ?? null,
          action,
          entityType,
          entityId !== null && entityId !== undefined ? String(entityId) : null,
          summary,
          metadata,
          req.method,
          req.originalUrl,
          res.statusCode,
          req.ip ?? null,
        ]
      ).catch(err => {
        // Never propagate — an audit failure must not affect the user.
        monitor.error('audit.write', err, { entity_type: entityType, action })
      })
    })

    next()
  }
}
