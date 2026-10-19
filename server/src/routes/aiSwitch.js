// The platform AI stop (Stage 7). Operators only, bound by USER ID, not by
// the JWT email (Argus ARG-280R3-1): req.user.id must be listed in
// AI_SWITCH_OPERATOR_USER_IDS (comma-separated ochr_users ids — the Dale/CoS
// seats). Unset, empty or unparsable → nobody (404). The email-based
// SUPER_ADMIN_EMAIL/VENDOR_ADMIN_EMAILS identity is deliberately NOT
// accepted here; binding that globally is F-01 v2. Anyone else gets 404. GET reads, PUT sets { stopped, reason }.
// Stopping is effective immediately for every sync and async AI path in
// both apps (ai/gate.js). Nothing resumes it automatically.
import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

export function isAiSwitchOperator(req) {
  const ids = String(process.env.AI_SWITCH_OPERATOR_USER_IDS || '')
    .split(',').map(s => s.trim()).filter(s => /^[1-9][0-9]{0,18}$/.test(s))
  const uid = req.user?.id
  return Number.isInteger(uid) && uid > 0 && ids.includes(String(uid))
}

router.use((req, res, next) => (isAiSwitchOperator(req) ? next() : res.status(404).json({ error: 'Not found' })))

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT stopped, reason, changed_by, changed_at FROM ochr_platform_ai_switch WHERE id = 1')
    res.json(rows[0] ?? { stopped: false, reason: null, changed_by: null, changed_at: null })
  } catch (err) {
    monitor.error('ai.switch.get', err, {})
    res.status(500).json({ error: 'Failed to read the AI switch' })
  }
})

router.put('/', async (req, res) => {
  if (typeof req.body?.stopped !== 'boolean') return res.status(400).json({ error: 'stopped must be true or false' })
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) || null : null
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO ochr_platform_ai_switch (id, stopped, reason, changed_by, changed_at)
       VALUES (1, $1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE SET stopped = EXCLUDED.stopped, reason = EXCLUDED.reason,
         changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at
       RETURNING stopped, reason, changed_by, changed_at`,
      [req.body.stopped, reason, req.user.id])
    await client.query(
      'INSERT INTO ochr_platform_ai_switch_events (stopped, reason, changed_by) VALUES ($1, $2, $3)',
      [req.body.stopped, reason, req.user.id])
    // R3-5: mirrored into the ordinary audit trail, in the same transaction.
    // R4-2: an emergency STOP must not depend on the audit table. The audit
    // insert runs under a savepoint; if it fails, a stop still commits (the
    // events row above is its trail) and the failure is reported. A resume
    // with a failed audit insert rolls back: resuming is never urgent.
    await client.query('SAVEPOINT ai_switch_audit')
    try {
      await client.query(
      `INSERT INTO ochr_audit_log
         (organization_id, user_id, user_email, user_name, action, entity_type, entity_id,
          summary, metadata, request_method, request_path, status_code)
       VALUES ($1, $2, $3, $4, 'update', 'ai_switch', '1', $5, $6::jsonb, 'PUT', '/api/admin/ai-switch', 200)`,
      [req.organizationId, req.user.id, req.user.email ?? null, req.user.name ?? null,
       req.body.stopped ? 'Stopped platform AI' : 'Resumed platform AI',
       JSON.stringify({ stopped: req.body.stopped, reason })])
    } catch (auditErr) {
      if (req.body.stopped !== true) throw auditErr
      await client.query('ROLLBACK TO SAVEPOINT ai_switch_audit')
      // R5-1: a pg error's detail can quote row values (user email/name,
      // reason). Report only the SQLSTATE code with a generic Error.
      monitor.error('ai.switch.audit', new Error('ai.switch.audit failed'), {
        stopped: true,
        code: typeof auditErr?.code === 'string' ? auditErr.code : null,
      })
    }
    await client.query('COMMIT')
    res.json(rows[0])
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('ai.switch.put', err, {})
    res.status(500).json({ error: 'Failed to change the AI switch' })
  } finally {
    client.release()
  }
})

export default router
