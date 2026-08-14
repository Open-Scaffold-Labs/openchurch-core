// Recurring-gift charger (GIV.7). A cron calls chargeDueRecurringGifts()
// on a cycle; it charges every active recurring gift that's due, records
// an ordinary donation per charge (so recurring giving flows into the
// same stats/statements), and advances the schedule. Runs across all
// orgs — it's invoked from the cron context, not per-tenant.
//
// Charges go through the vendor-neutral payments stub today; the day a
// provider is wired, this code is unchanged.

import pool from '../db.js'
import { createCharge } from '../payments/index.js'
import { monitor } from '../monitoring/index.js'

// Closed set → safe to interpolate into the interval arithmetic.
const STEP = { weekly: "INTERVAL '7 days'", monthly: "INTERVAL '1 month'" }

export async function chargeDueRecurringGifts() {
  let processed = 0, charged = 0, failed = 0, deduped = 0

  const { rows: due } = await pool.query(
    `SELECT rg.id, rg.organization_id, rg.fund_id, rg.donor_name, rg.donor_email,
            rg.amount, rg.frequency, rg.next_charge_date::text AS due_date,
            f.name AS fund_name
       FROM ochr_recurring_gifts rg
       LEFT JOIN ochr_funds f ON f.id = rg.fund_id
      WHERE rg.status = 'active' AND rg.next_charge_date <= CURRENT_DATE
      ORDER BY rg.next_charge_date ASC
      LIMIT 500`
  )

  for (const g of due) {
    processed++
    // One gift + one billing period = one key, forever. A cron retry
    // (timeout mid-batch, redeploy, double invocation) re-derives the
    // SAME key, so the provider dedupes the charge and the donation
    // insert conflicts instead of duplicating. The due date comes from
    // the row itself — not "today" — so a gift that was due Monday and
    // retried Wednesday still maps to the Monday period.
    const dueDate = String(g.due_date).slice(0, 10)
    const idempotencyKey = `rg${g.id}-${dueDate}`

    try {
      const charge = await createCharge({
        organizationId: g.organization_id,
        amount:         Number(g.amount),
        currency:       'usd',
        donorName:      g.donor_name,
        donorEmail:     g.donor_email || undefined,
        idempotencyKey,
        metadata:       { recurring_gift_id: g.id, fund_id: g.fund_id, due_date: dueDate },
      })

      // Record the donation and advance the schedule ATOMICALLY. If the
      // process dies before COMMIT, nothing half-happens: the schedule
      // stays un-advanced, the retry re-charges under the same
      // idempotency key (no second movement of money), and both writes
      // land together on the second pass.
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const category = g.fund_name || 'Recurring gift'
        // Idempotent on (org, payment_ref) via uq_donations_org_payment_ref
        // (050) — a retried period conflicts instead of double-posting.
        const inserted = await client.query(
          `INSERT INTO ochr_donations
             (organization_id, donor_name, donor_email, amount, category, method, date,
              source, fund_id, payment_ref, payment_status, notes)
           VALUES ($1, $2, $3, $4, $5, 'online', CURRENT_DATE, 'recurring', $6, $7, $8, 'Recurring gift')
           ON CONFLICT (organization_id, payment_ref) WHERE payment_ref IS NOT NULL
           DO NOTHING`,
          [g.organization_id, g.donor_name, g.donor_email || null, Number(g.amount), category, g.fund_id, charge.id, charge.status]
        )

        // The advance is guarded on the due date we selected: if a
        // concurrent run already moved the schedule for this period,
        // rowCount is 0 and we have changed nothing twice.
        await client.query(
          `UPDATE ochr_recurring_gifts
              SET next_charge_date = next_charge_date + ${STEP[g.frequency] || STEP.monthly},
                  last_charged_at  = NOW()
            WHERE id = $1 AND status = 'active' AND next_charge_date = $2::date`,
          [g.id, dueDate]
        )

        await client.query('COMMIT')
        if (inserted.rowCount === 0) deduped++
        else charged++
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    } catch (err) {
      failed++
      monitor.error('recurring.charge', err, { recurringGiftId: g.id, orgId: g.organization_id })
    }
  }

  return { processed, charged, failed, deduped }
}
