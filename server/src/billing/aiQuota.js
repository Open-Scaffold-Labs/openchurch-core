// Per-org AI quota — read by /api/ai/generate (and eventually
// /api/ai/enhance) to gate calls against the plan's
// ai_generations_per_month limit. Records usage AFTER a successful
// LLM call so failed/aborted calls don't count.
//
// Period semantics: calendar month (UTC) starting on the 1st. We
// don't pro-rate or roll over — at the top of each month, the count
// resets implicitly because the COUNT(*) WHERE created_at >= X
// query rolls forward.
//
// Limit semantics:
//   - undefined plan → falls back to free (matches getPlan)
//   - null limit     → unlimited (returned as `limit: null`, exceeded:false)
//   - integer limit  → exceeded when used >= limit
//
// All functions are pool.query-driven; no caching here. At
// OpenChurch's scale (1–50 churches per founder principle), the
// indexed COUNT(*) is fine. If we ever add Redis, this is the spot.

import pool from '../db.js'
import { getPlan } from './plans.js'

// Compute the start of the current calendar month in UTC. Returned as
// an ISO string so the SQL parameter is unambiguous.
function periodStart(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0))
  return d
}

// Compute the start of NEXT calendar month — used to display the
// reset moment in the UI ("resets in 3 days").
function periodEnd(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0))
  return d
}

// Look up an org's current plan id from ochr_organizations. Falls
// back to 'free' if the row is missing a plan (legacy data).
async function planIdFor(orgId) {
  const { rows } = await pool.query(
    `SELECT plan FROM ochr_organizations WHERE id = $1`,
    [orgId]
  )
  return rows[0]?.plan || 'free'
}

// Count successful AI calls for the org within the current period.
async function currentUsage(orgId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM ochr_ai_usage
      WHERE organization_id = $1
        AND created_at >= $2`,
    [orgId, periodStart()]
  )
  return rows[0].n
}

// Public: full quota snapshot for an org. Used by the gate AND the
// GET /api/ai/quota endpoint (UI meter).
export async function quotaFor(orgId) {
  const planId = await planIdFor(orgId)
  const plan   = getPlan(planId)
  const limit  = plan.limits?.ai_generations_per_month ?? null
  const used   = await currentUsage(orgId)

  const exceeded  = limit !== null && used >= limit
  const remaining = limit === null ? null : Math.max(limit - used, 0)

  return {
    plan:         planId,
    used,
    limit,             // null = unlimited
    remaining,         // null = unlimited
    exceeded,
    period_start: periodStart().toISOString(),
    period_end:   periodEnd().toISOString(),
  }
}

// Insert a usage row. Called only after a successful LLM response
// (failed calls don't count against the user's quota).
export async function recordUsage(orgId, { endpoint, type, userId, provider, model }) {
  await pool.query(
    `INSERT INTO ochr_ai_usage (organization_id, endpoint, type, user_id, provider, model)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orgId, endpoint, type ?? null, userId ?? null, provider ?? null, model ?? null]
  )
}

// Atomic check-and-reserve. Closes the TOCTOU race that let concurrent
// requests all pass a plain COUNT(*) gate when only one slot remained:
// we INSERT the usage row FIRST (reserving the slot) inside a transaction,
// then re-count WITHIN the same transaction. If the reservation pushed the
// org over its limit we ROLLBACK and report exceeded — so two concurrent
// requests contending for the last slot can't both win. Under the plain
// gate the loser's insert would still land after the count; here its own
// re-count sees itself and any winner, and it backs out.
//
// The row is provisional: recordUsage-style metadata is written up front,
// but if the subsequent LLM call fails the caller calls releaseSlot(id) to
// refund it (failed calls don't count). Returns:
//   { reserved: true,  id }                — slot held; call the LLM
//   { reserved: false, quota }             — at/over limit; caller 429s
// Throws on DB error so the caller can FAIL CLOSED (never silently proceed).
export async function reserveSlot(orgId, { endpoint, type, userId, provider, model }) {
  const planId = await planIdFor(orgId)
  const plan   = getPlan(planId)
  const limit  = plan.limits?.ai_generations_per_month ?? null

  // Unlimited plan — no counting or reservation needed, but we still
  // record a usage row so analytics/reporting (ochr_ai_usage) sees
  // unlimited-org activity. Return its id so provider/model can be
  // filled in after the LLM call and so a failed call can refund it.
  if (limit === null) {
    const { rows } = await pool.query(
      `INSERT INTO ochr_ai_usage (organization_id, endpoint, type, user_id, provider, model)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [orgId, endpoint, type ?? null, userId ?? null, provider ?? null, model ?? null]
    )
    return { reserved: true, id: rows[0].id }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialize concurrent reservations for THIS org so the INSERT-then-COUNT
    // check-and-reserve is genuinely race-free even under READ COMMITTED (the
    // pool's default isolation, where a txn's COUNT sees its own uncommitted
    // insert but not a peer's — letting two requests both pass on the last
    // slot). A transaction-scoped advisory lock auto-releases on COMMIT/
    // ROLLBACK, and because it lives inside this single pinned transaction it
    // behaves correctly through Supabase's transaction-mode pooler. hashtext()
    // maps the org id (int or uuid) into the bigint key the lock expects.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(orgId)])
    const { rows: ins } = await client.query(
      `INSERT INTO ochr_ai_usage (organization_id, endpoint, type, user_id, provider, model)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [orgId, endpoint, type ?? null, userId ?? null, provider ?? null, model ?? null]
    )
    const { rows: cnt } = await client.query(
      `SELECT COUNT(*)::int AS n FROM ochr_ai_usage
        WHERE organization_id = $1 AND created_at >= $2`,
      [orgId, periodStart()]
    )
    const used = cnt[0].n
    if (used > limit) {
      // This reservation tipped us over — back it out and refuse. `used`
      // includes our just-inserted row, so the surfaced count reflects the
      // pre-reservation total (used - 1) capped at the limit.
      await client.query('ROLLBACK')
      const priorUsed = Math.min(used - 1, limit)
      return {
        reserved: false,
        quota: {
          plan:         planId,
          used:         priorUsed,
          limit,
          remaining:    Math.max(limit - priorUsed, 0),
          exceeded:     true,
          period_start: periodStart().toISOString(),
          period_end:   periodEnd().toISOString(),
        },
      }
    }
    await client.query('COMMIT')
    return { reserved: true, id: ins[0].id }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* ignore */ }
    throw err
  } finally {
    client.release()
  }
}

// Fill in the provider/model on a reserved usage row once the LLM call
// succeeds and we know which provider actually served it. Reservation
// happens before runLLM (provider unknown), so the row starts with null
// provider/model; this restores the per-provider/model breakdown that
// recordUsage used to write. Best-effort: a null id is a no-op.
export async function updateSlotProvider(id, { provider, model }) {
  if (id == null) return
  await pool.query(
    'UPDATE ochr_ai_usage SET provider = $2, model = $3 WHERE id = $1',
    [id, provider ?? null, model ?? null]
  )
}

// Refund a reserved slot when the LLM call that follows a successful
// reserveSlot() ends up failing — so failed calls don't count against the
// org's quota. Best-effort: a failed refund is logged by the caller, never
// surfaced. A null id (unlimited plan) is a no-op.
export async function releaseSlot(id) {
  if (id == null) return
  await pool.query('DELETE FROM ochr_ai_usage WHERE id = $1', [id])
}
