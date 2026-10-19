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
//     Failed/refused attempts stay out of the operational trail by
//     policy (AUDIT-L2-04). Security/monitor logs are a different lane.
//   - Sub-path POSTs (void / restore / assign / unassign / commit) are
//     not bare "create". They stay inside create|update|delete — no
//     schema or allowlist redesign — and metadata.op names the verb so
//     the trail correlates to sacrament amendments without copying
//     before/after JSON into the audit log (audit is not a second
//     canonical register).

import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

// POST sub-paths that mutate (or, for commit, create) a known entity.
// Order matters: /unassign before /assign.
const SUBPATH_OPS = [
  { re: /\/void\/?$/i,     action: 'update', op: 'void',     verb: 'Voided' },
  { re: /\/restore\/?$/i,  action: 'update', op: 'restore',  verb: 'Restored' },
  { re: /\/unassign\/?$/i, action: 'update', op: 'unassign', verb: 'Unassigned' },
  { re: /\/assign\/?$/i,   action: 'update', op: 'assign',   verb: 'Assigned' },
  { re: /\/commit\/?$/i,   action: 'create', op: 'commit',   verb: 'Committed' },
]

// Login lifecycle (Stage 6). Closing a login, turning it off and turning
// it back on change a login's state; the ochr_users row stays. Read
// generically, those requests were stored as "Created user", the legacy
// DELETE /users/:id (which closes, never deletes) as "Deleted user", and the
// self-service routes left no row at all.
//
// The handler that actually changed the login says so on res.locals
// (markLoginLifecycle below), with the id it parsed and acted on. Nothing
// here re-reads the URL: Express routes case-insensitively, a :id of "007"
// is user 7, and a second parse of the path can disagree with the first.
//
// The row's `action` is the lifecycle op itself — close / deactivate /
// reactivate. Only this middleware writes those values, so a row from
// before this change (create / update / delete, whatever its metadata says)
// can never be read as a lifecycle row. Earlier rows are not rewritten.
export const LIFECYCLE_ACTIONS = ['close', 'deactivate', 'reactivate']

const LIFECYCLE_TEXT = {
  close:      { admin: 'Closed login',         self: 'Closed own login',         already: 'already closed' },
  deactivate: { admin: 'Turned login off',     self: 'Turned own login off',     already: 'already off' },
  reactivate: { admin: 'Turned login back on', self: 'Turned own login back on', already: 'already on' },
}
const LIFECYCLE_VIA = new Set(['admin', 'self', 'legacy-delete'])

// Called by a route after it changed (or confirmed) a login's state.
// `targetId` is the integer the route parsed and acted on; `already` is the
// route's own answer that nothing changed.
// Never throws: it runs after the login already changed, and a 500 then
// would tell the admin the change failed when it did not. A bad call is
// reported and the row falls back to the generic label.
export function markLoginLifecycle(res, { op, via, targetId, already = false }) {
  if (!LIFECYCLE_TEXT[op] || !LIFECYCLE_VIA.has(via) || !Number.isSafeInteger(targetId) || targetId <= 0) {
    monitor.error('audit.lifecycle_mark', new Error('invalid login lifecycle mark'), { op, via, targetId })
    return
  }
  res.locals.loginLifecycle = { op, via, targetId, already: already === true }
}

function lifecycleRecord(life, req) {
  const targetId = String(life.targetId)
  const text = LIFECYCLE_TEXT[life.op]
  const verb = life.via === 'self' ? text.self : text.admin
  const summary = `${verb} #${targetId}${life.already ? ` (${text.already})` : ''}`
  const metadata = { via: life.via, ...(life.already ? { already: true } : {}) }
  // Closing your own login (either door) scrubs your name and email from
  // the log (loginClosure.js), and migration 112's BEFORE INSERT trigger
  // minimizes late writes. This row is written after the closure, so it
  // does not offer them in the first place.
  const scrubActor = life.op === 'close' && targetId === String(req.user.id)
  return { action: life.op, entityId: targetId, summary, metadata, scrubActor }
}

// Stage 6 stewardship actions. Minimizing a member's contact details and
// placing the organization on hold are POSTs; read generically they would be
// stored as "Created client" / "Created organization". The route that did
// the work marks the row (markStewardship), with the id it acted on; the
// action value is written only here, so no request body and no earlier row
// can produce it. Same contract as markLoginLifecycle.
export const STEWARDSHIP_ACTIONS = ['deidentify', 'hold']

const STEWARDSHIP = {
  deidentify: { entity: 'client',       text: 'Minimized member contact details', already: 'already minimized' },
  hold:       { entity: 'organization', text: 'Placed organization on hold',      already: 'already on hold' },
}

export function markStewardship(res, { action, targetId, already = false, incomplete = false }) {
  if (!STEWARDSHIP[action] || !Number.isSafeInteger(targetId) || targetId <= 0) {
    monitor.error('audit.stewardship_mark', new Error('invalid stewardship mark'), { action, targetId })
    return
  }
  res.locals.stewardship = { action, targetId, already: already === true, incomplete: incomplete === true }
}

function stewardshipRecord(mark) {
  const def = STEWARDSHIP[mark.action]
  const id = String(mark.targetId)
  return {
    action: mark.action,
    entityId: id,
    summary: `${def.text} #${id}${mark.already ? ` (${def.already})` : ''}${mark.incomplete ? ' (access cleanup incomplete)' : ''}`,
    metadata: { ...(mark.already ? { already: true } : {}), ...(mark.incomplete ? { cleanup_complete: false } : {}) },
    scrubActor: false,
  }
}

function actionFor(method) {
  if (method === 'POST') return 'create'
  if (method === 'DELETE') return 'delete'
  return 'update'
}

function pathOnly(url) {
  return String(url || '').split('?')[0]
}

function resolveSubpathOp(url) {
  const p = pathOnly(url)
  for (const row of SUBPATH_OPS) {
    if (row.re.test(p)) return row
  }
  return null
}

// Prefer the permanent resource when a nested response wraps it
// (draft commit returns { record, draft }). Fall back to :id.
function resolveEntityId(req, responseBody) {
  if (responseBody?.record?.id != null) return String(responseBody.record.id)
  if (responseBody?.id != null) return String(responseBody.id)
  if (Array.isArray(responseBody?.drafts) && responseBody.drafts[0]?.id != null) {
    return String(responseBody.drafts[0].id)
  }
  if (req.params?.id != null) return String(req.params.id)
  return null
}

// Build a short human-readable summary. Prefers fields people would
// recognize ("name" for members, "title" for events/tasks). Falls back
// to "<entity> #<id>" when no identifying string is around.
// R3-3: a check-in summary never reads a body (names live there); it is
// built from the action, entity type and id only.
function summaryFor(entityType, action, responseBody, reqBody, entityId, subOp) {
  if (entityType === 'checkin' || entityType === 'mass_intention') return buildSummary(entityType, action, null, entityId, subOp)
  return buildSummary(entityType, action, responseBody ?? reqBody, entityId, subOp)
}

function buildSummary(entityType, action, body, entityId, subOp) {
  const handle =
    body?.name ||
    body?.title ||
    body?.donor_name ||
    body?.record?.member_name ||
    null
  const idPart = entityId ? ` #${entityId}` : ''
  if (subOp) {
    if (handle) return `${subOp.verb} ${entityType}: ${handle}`
    return `${subOp.verb} ${entityType}${idPart}`
  }
  if (action === 'create' && handle) return `Created ${entityType}: ${handle}`
  if (action === 'create')           return `Created ${entityType}`
  if (action === 'update' && handle) return `Updated ${entityType}: ${handle}`
  if (action === 'update')           return `Updated ${entityType}${idPart}`
  if (action === 'delete')           return `Deleted ${entityType}${idPart}`
  return `${action} ${entityType}`
}

// Sanitize the request body before persisting to metadata. Strips
// secrets and large blobs so the audit table stays small and safe
// (no plaintext passwords, no megabyte-sized CSV imports). Does NOT
// copy register before/after snapshots — those live on
// ochr_sacrament_amendments.
// Keys compared without case, `_`, `-` or spaces, so securityCode,
// pickup-code, PIN_CODE and pincode all read the same.
const DENY_KEY = /password|token|secret|authorization|apikey|privatekey|cookie|cvv|ssn|^code$|(security|pickup)code|^pin(code|number|\d*)$/
const MAX_DEPTH = 4

function deniedKey(k) {
  return DENY_KEY.test(String(k).toLowerCase().replace(/[\s_-]/g, ''))
}

function sanitizeValue(v, depth) {
  if (typeof v === 'string') return v.length > 500 ? `${v.slice(0, 500)}…` : v
  if (!v || typeof v !== 'object') return v
  // Past the depth bound a nested value is dropped, never copied verbatim.
  if (depth >= MAX_DEPTH) return undefined
  if (Array.isArray(v)) return v.map(x => sanitizeValue(x, depth + 1)).filter(x => x !== undefined)
  const out = {}
  for (const [k, x] of Object.entries(v)) {
    if (deniedKey(k)) continue
    const clean = sanitizeValue(x, depth + 1)
    if (clean !== undefined) out[k] = clean
  }
  return out
}

function sanitizeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  return sanitizeValue(body, 0)
}

// op / via / already are written by this middleware and read by the audit
// page to label a row (a lifecycle row renders "Closed login"). No route
// takes them in a body, so a client-sent copy is dropped rather than
// allowed to label an ordinary create or edit as something it wasn't.
const RESERVED_METADATA = ['op', 'via', 'already']

function buildMetadata({ action, entityType, reqBody, subOp }) {
  if (action === 'delete') return {}
  const metadata = sanitizeBody(reqBody)
  for (const k of RESERVED_METADATA) delete metadata[k]
  if (subOp) {
    metadata.op = subOp.op
    return metadata
  }
  // Sacrament PATCH with a reason is a register correction. Tag it so
  // the operational trail correlates to ochr_sacrament_amendments by
  // entity_id + op, without storing before/after JSON here.
  if (
    entityType === 'sacrament' &&
    action === 'update' &&
    typeof metadata.reason === 'string' &&
    metadata.reason.trim().length >= 3
  ) {
    metadata.op = 'correction'
  }
  return metadata
}

// Check-in rows (Stage 7, TARS #280 dispositions 1-2). NEW check-in audit
// rows carry operational ids and the action only: no child, guest or
// guardian name (the operational check-in row keeps what safe pickup needs,
// under the existing 2-day / 400-day policy), and checkout carries no
// request text at all — no note, no code spelling. Historical rows are not
// rewritten here.
const CHECKIN_AUDIT_KEYS = ['calendar_event_id', 'client_id', 'kind', 'room_id']

function isCheckinCheckout(entityType, url) {
  return entityType === 'checkin' && /\/checkout\/?$/i.test(pathOnly(url))
}

// SP-052 / R285-3: Mass intention audit rows are a CLOSED, typed projection
// of the handled resource (the route's success response), never of the
// request body. Intention text, requester text, notes, stipend and any
// unknown or nested key cannot reach audit; the canonical text stays on the
// intention row. Ids are re-read as positive integers; status is an enum.
const MI_AUDIT_STATUSES = new Set(['open', 'scheduled', 'fulfilled', 'cancelled'])
const posInt = v => (Number.isSafeInteger(v) && v > 0 ? v : (typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null))

// R285-F1: a closed allowlist of field NAMES an edit may report as changed,
// in a fixed order. Stipend alone also carries numeric before/after.
const MI_AUDIT_CHANGE_FIELDS = ['intention', 'note', 'requested_by', 'requested_by_client_id', 'stipend', 'mass_date', 'status', 'calendar_event_id']
const finiteOrNull = v => {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function massIntentionAuditMetadata({ action, subOp, change, snapshot }) {
  if (action === 'delete') return {}
  const out = {}
  // R285-4 / R4-L1: every write projects the typed snapshot of the row THIS
  // request saved (create/PATCH/assign/unassign RETURNING, or the locked row
  // on a no-op), never the post-save re-read in the response body, which a
  // concurrent writer can change first. No snapshot → ids are not guessed.
  if (subOp) out.op = subOp.op
  if (!snapshot || typeof snapshot !== 'object') return out
  const row = snapshot
  const id = posInt(row.id)
  if (id != null) out.intention_id = id
  const member = posInt(row.requested_by_client_id)
  out.requested_by_client_id = member
  out.calendar_event_id = posInt(row.calendar_event_id)
  if (MI_AUDIT_STATUSES.has(row.status)) out.status = row.status
  // R285-F1/F2: an edit names the fields whose STORED value changed (the
  // route compares the locked row with the UPDATE's RETURNING row). The link
  // label is written only when the stored member id really changed, so a
  // re-sent id or a null on an unlinked row is not called linked/unlinked.
  // `member` is from the same committed snapshot (R285-4).
  if (action === 'update' && !subOp && change && Array.isArray(change.changed)) {
    const changed = MI_AUDIT_CHANGE_FIELDS.filter(f => change.changed.includes(f))
    out.changed = changed
    if (changed.includes('stipend')) {
      out.stipend_before = finiteOrNull(change.stipend_before)
      out.stipend_after = finiteOrNull(change.stipend_after)
    }
    if (changed.includes('requested_by_client_id')) {
      out.link = member != null ? 'linked' : 'unlinked'
    }
  }
  return out
}

function checkoutAuditMetadata() {
  return {}
}

function checkinAuditMetadata(body) {
  const out = {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) return out
  for (const k of CHECKIN_AUDIT_KEYS) {
    const v = body[k]
    if (v == null) continue
    if (typeof v === 'number' || (typeof v === 'string' && v.length <= 40)) out[k] = v
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

      const life = entityType === 'user' ? res.locals?.loginLifecycle : null
      const stew = res.locals?.stewardship
      const stewardship = stew && STEWARDSHIP[stew.action]?.entity === entityType ? stew : null
      let action, entityId, summary, metadata, scrubActor = false
      if (life) {
        ({ action, entityId, summary, metadata, scrubActor } = lifecycleRecord(life, req))
      } else if (stewardship) {
        ({ action, entityId, summary, metadata, scrubActor } = stewardshipRecord(stewardship))
      } else {
        const subOp = resolveSubpathOp(req.originalUrl)
        action = subOp?.action ?? actionFor(req.method)
        entityId = resolveEntityId(req, responseBody)
        // R3-3: a check-in summary never reads the body (names live there);
        // it is built from the action, entity type and id only.
        // R5-3: called through the seam object so a test can spy on it.
        summary = _auditInternalsForTests.summaryFor(entityType, action, responseBody, req.body, entityId, subOp)
        metadata = entityType === 'mass_intention'
          ? massIntentionAuditMetadata({ action, subOp, change: res.locals?.massIntentionChange, snapshot: res.locals?.massIntentionSnapshot })
          : isCheckinCheckout(entityType, req.originalUrl)
          ? checkoutAuditMetadata()
          : entityType === 'checkin'
            ? (action === 'delete' ? {} : checkinAuditMetadata(req.body))
            : buildMetadata({
            action,
            entityType,
            reqBody: req.body,
            subOp,
          })
      }

      pool.query(
        `INSERT INTO ochr_audit_log
           (organization_id, user_id, user_email, user_name, action, entity_type,
            entity_id, summary, metadata, request_method, request_path,
            status_code, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          req.organizationId,
          req.user.id,
          scrubActor ? null : (req.user.email ?? null),
          scrubActor ? null : (req.user.name ?? null),
          action,
          entityType,
          entityId,
          summary,
          metadata,
          req.method,
          pathOnly(req.originalUrl),
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

// Test seam for AUDIT-L2-04 mutation probes. Not used in production paths.
export const _auditInternalsForTests = {
  lifecycleRecord,
  resolveSubpathOp,
  resolveEntityId,
  buildSummary,
  summaryFor,
  buildMetadata,
  sanitizeBody,
  checkoutAuditMetadata,
  checkinAuditMetadata,
  pathOnly,
  actionFor,
}
