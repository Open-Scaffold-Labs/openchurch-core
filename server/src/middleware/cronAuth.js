// Cron-only auth. Vercel cron invocations send
//   Authorization: Bearer ${CRON_SECRET}
// when the env var is set on the deployment. Our cron endpoints
// (retention prune, birthday enqueue, notification drain) need a
// way to authenticate that doesn't involve a JWT — there's no
// human user behind a cron call. This middleware checks that header
// against the env-supplied secret.
//
// Posture:
//   - CRON_SECRET unset       → 503 (cron not configured for this env)
//   - mismatched/missing auth → 401
//   - matched                 → next()
//
// Returning 503 when the env is missing is louder than 401 — it
// surfaces a misconfigured deploy as a real failure rather than
// looking like a permissions bug.

import { monitor } from '../monitoring/index.js'

export function requireCronAuth(req, res, next) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    monitor.warn('cron.unconfigured', 'CRON_SECRET env var is not set; cron endpoints will refuse all callers.')
    return res.status(503).json({ error: 'Cron not configured' })
  }
  const got = req.headers.authorization
  if (got !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}
