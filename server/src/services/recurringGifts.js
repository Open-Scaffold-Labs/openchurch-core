// Recurring-gift charger (GIV.7). A cron calls chargeDueRecurringGifts()
// on a cycle; it charges every active recurring gift that's due, records
// an ordinary donation per charge (so recurring giving flows into the
// same stats/statements), and advances the schedule. Runs across all
// orgs — it's invoked from the cron context, not per-tenant.
//
// Charges go through the vendor-neutral payments stub today; the day a
// provider is wired, this code is unchanged.

import pool from '../db.js'
import { createCharge, paymentsConfigured, canChargeSavedCards, paymentsProvider } from '../payments/index.js'
import { monitor } from '../monitoring/index.js'
import { notify, languageFor } from '../notifications/transport.js'

// Closed set → safe to interpolate into the interval arithmetic.
const STEP = { weekly: "INTERVAL '7 days'", monthly: "INTERVAL '1 month'" }

// ── What happens when a charge fails ──────────────────────────────────────
//
// Before this, nothing did. The catch block logged a monitor line and left
// the row active with next_charge_date untouched, so a gift whose card had
// expired was due forever: retried every single run, silently, with no
// counter and nobody told. The donor believed they were giving monthly. The
// parish believed it had the income.
//
// The escalation (Jose's call, 24 Aug): the DONOR hears first and privately.
// Only if it keeps failing does it reach the office. Someone whose card was
// momentarily declined fixes it without the secretary ever knowing; someone
// who has genuinely stopped becomes a conversation a person can have.
//
// Retries are spaced, not daily — a card that needs replacing needs days, and
// three attempts a day apart is three attempts nobody could have acted on.
// The whole sequence resolves or gives up inside about ten days.
const RETRY_AFTER_DAYS = [3, 7]   // after failure 1, then failure 2
const MAX_ATTEMPTS     = 3        // then pause and tell the parish

// A notification must never be the reason a charge run dies. notify() reaches
// the transport, which reaches email, which is somebody else's outage.
async function notifyQuietly(payload) {
  try { await notify(payload) }
  catch (err) { monitor.error('recurring.notify', err, { type: payload.notification_type }) }
}

// {{frequency}} is a database enum — 'weekly' / 'monthly'. Interpolating it
// raw put an English word inside a Spanish sentence ("su ofrenda monthly de
// $50.00") for exactly the donor the bilingual work exists for. Translate it
// at the point of use; the enum stays the enum.
const FREQUENCY_WORD = {
  en: { weekly: 'weekly',    monthly: 'monthly' },
  es: { weekly: 'semanal',   monthly: 'mensual' },
}
const frequencyWord = (freq, lang) =>
  FREQUENCY_WORD[lang === 'es' ? 'es' : 'en'][freq] ?? freq

// Who at the parish hears that a gift stopped. The office notice had no
// recipient at all, so it fell to the console stub and would have gone
// nowhere even with a live mail provider — the final step of the escalation
// reaching nobody. Same shape as the birthday digest: resolve admins, notify
// each, so the message has somewhere to arrive.
export async function parishAdmins(organizationId) {
  const { rows } = await pool.query(
    `SELECT id, email FROM ochr_users
      WHERE organization_id = $1 AND role = 'admin' AND email IS NOT NULL
        -- F-06 / ARG-PATCH-2-2: never a closed or deactivated admin
        AND closed_at IS NULL AND deactivated_at IS NULL`,
    [organizationId])
  return rows
}

// Where a donor goes to set the gift up again. The slug is the parish's
// public identity and is already how every other public link is built.
function givingUrl(slug) {
  const base = (process.env.CLIENT_URL || 'http://localhost:5202').replace(/\/$/, '')
  return slug ? `${base}/p/${slug}/give` : base
}

export async function chargeDueRecurringGifts() {
  // The same refusal the public giving route makes, for the same reason: with
  // no provider chosen, createCharge falls to the stub, which returns a
  // synthetic 'succeeded' — and this function then writes a real donation row
  // that reaches the dashboard, the diocesan assessable base and the donor's
  // tax statement, having moved no money.
  //
  // That guard was added to publicEvents.js and NOT here, which is the same
  // fixed-where-found mistake three other findings today were about — and it
  // matters more here, because this path runs unattended on a daily cron
  // rather than only when somebody visits a page.
  if (!paymentsConfigured()) {
    return { processed: 0, charged: 0, failed: 0, deduped: 0, paused: 0,
             recovered: 0, skipped: 'no payment provider configured' }
  }

  // A provider that cannot charge a saved card cannot run this job. Letting it
  // try turns one missing capability into every donor's card apparently being
  // declined at once: three failed attempts each, every gift paused, every
  // donor emailed to say their gift could not be taken. None of that would be
  // true — no card was ever presented — and the parish would lose its whole
  // recurring base to a configuration change.
  //
  // Declining once, loudly, is the honest answer. Nothing is charged, nothing
  // is paused, no donor is written to, and the run says exactly why.
  if (!canChargeSavedCards()) {
    monitor.warn('recurring.unsupported',
      `Recurring charging is not available on the '${paymentsProvider()}' provider. ` +
      'No gifts were charged, paused, or cancelled, and no donors were contacted. ' +
      'One-time gifts are unaffected.')
    return { processed: 0, charged: 0, failed: 0, deduped: 0, paused: 0, recovered: 0,
             skipped: `provider '${paymentsProvider()}' cannot charge saved cards` }
  }

  let processed = 0, charged = 0, failed = 0, deduped = 0, paused = 0, recovered = 0

  const { rows: due } = await pool.query(
    `SELECT rg.id, rg.organization_id, rg.fund_id, rg.donor_name, rg.donor_email,
            rg.amount, rg.frequency, rg.next_charge_date::text AS due_date,
            rg.failure_count,
            to_char(rg.first_failed_at, 'YYYY-MM-DD') AS first_failed,
            o.name AS church_name,
            f.name AS fund_name,
            o.slug AS org_slug
       FROM ochr_recurring_gifts rg
       LEFT JOIN ochr_funds f ON f.id = rg.fund_id
       JOIN ochr_organizations o ON o.id = rg.organization_id
      -- Due on the EFFECTIVE date (a pending retry, else the anniversary),
      -- while due_date above stays the anniversary so the idempotency key
      -- names the billing period rather than the attempt. See migration 092.
      WHERE rg.status = 'active'
        AND o.held_at IS NULL
        AND COALESCE(rg.retry_after, rg.next_charge_date) <= CURRENT_DATE
      ORDER BY COALESCE(rg.retry_after, rg.next_charge_date) ASC
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

    // Admission before money moves. The organization's KEY SHARE lock is
    // held from the hold check through the donation insert, so a HOLD placed
    // meanwhile waits for this gift to be charged AND recorded, and a gift
    // whose parish is already held is never charged. (A held parish's writes
    // are refused: charging first would move money with nowhere to record it.)
    const client = await pool.connect()
    let admitted = false
    try {
      await client.query('BEGIN')
      const { rows: [org] } = await client.query(
        'SELECT held_at FROM ochr_organizations WHERE id = $1 FOR KEY SHARE', [g.organization_id])
      if (!org || org.held_at != null) {
        await client.query('ROLLBACK')
        client.release()
        continue
      }
      admitted = true
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
      throw err
    }

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
      try {
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
        // failure_count resets to zero on any success. Without this, a gift
        // that failed once in January and once in June and once in November
        // would be paused for three unrelated reasons years apart — which
        // would read to the parish as somebody who had stopped giving.
        await client.query(
          `UPDATE ochr_recurring_gifts
              SET next_charge_date = next_charge_date + ${STEP[g.frequency] || STEP.monthly},
                  last_charged_at  = NOW(),
                  failure_count    = 0,
                  last_error       = NULL,
                  first_failed_at  = NULL,
                  -- The anniversary advances from itself, so a gift set up for
                  -- the 1st stays on the 1st however many retries it took.
                  retry_after      = NULL
            WHERE id = $1 AND status = 'active' AND next_charge_date = $2::date`,
          [g.id, dueDate]
        )

        await client.query('COMMIT')
        admitted = false
        if (inserted.rowCount === 0) deduped++
        else charged++
        if (Number(g.failure_count) > 0) recovered++
      } finally { /* the outer handler rolls back and releases */ }
    } catch (err) {
      if (admitted) await client.query('ROLLBACK').catch(() => {})
      admitted = false
      failed++
      monitor.error('recurring.charge', err, { recurringGiftId: g.id, orgId: g.organization_id })

      // Everything below is bookkeeping about a gift that did not go through.
      // None of it may be the reason the run dies — the next gift in the batch
      // is somebody else's and deserves its attempt regardless.
      try {
        const attempt = (Number(g.failure_count) || 0) + 1
        const reason  = String(err?.message ?? err).slice(0, 500)

        if (attempt >= MAX_ATTEMPTS) {
          // Give up, and say so in a state the office can see. 'paused' is
          // deliberately not 'cancelled': cancelled is the donor's decision.
          const { rows: [row] } = await pool.query(
            `UPDATE ochr_recurring_gifts
                SET status = 'paused', failure_count = $2,
                    last_error = $3, last_failed_at = NOW(),
                    first_failed_at = COALESCE(first_failed_at, NOW())
              WHERE id = $1 AND status = 'active'
              RETURNING failure_count,
                        to_char(last_failed_at, 'YYYY-MM-DD') AS last_failed`,
            [g.id, attempt, reason])
          if (row) {
            paused++
            // The donor hears that it STOPPED, not just that an attempt
            // failed. Without this the last thing they were told was "we will
            // try again" — and the parish is simultaneously told they were
            // notified every time, which was not true.
            if (g.donor_email) {
              await notifyQuietly({
                organizationId: g.organization_id,
                recipient: g.donor_email,
                notification_type: 'recurring_gift_stopped',
                vars: {
                  donor_name:  g.donor_name,
                  church_name: g.church_name,
                  amount:      `$${Number(g.amount).toFixed(2)}`,
                  giving_url:  givingUrl(g.org_slug),
                },
                lang: null,
              })
            }
            // …and the office, per admin, because a notification with no
            // recipient reaches nobody however good the wording is.
            for (const admin of await parishAdmins(g.organization_id)) {
              await notifyQuietly({
                organizationId: g.organization_id,
                userId:    admin.id,
                recipient: admin.email,
                notification_type: 'recurring_gift_paused',
                vars: {
                  donor_name: g.donor_name,
                  frequency:  frequencyWord(g.frequency, 'en'),
                  amount:     `$${Number(g.amount).toFixed(2)}`,
                  attempts:   String(attempt),
                  first_failed: g.first_failed ?? dueDate,
                  last_failed:  row.last_failed ?? dueDate,
                  last_error:   reason,
                },
              })
            }
          }
        } else {
          // Try again in a few days, not tomorrow. Guarded on the due date so
          // a concurrent run cannot push the schedule twice.
          const wait = RETRY_AFTER_DAYS[attempt - 1] ?? 3
          await pool.query(
            `UPDATE ochr_recurring_gifts
                SET failure_count = $2, last_error = $3, last_failed_at = NOW(),
                    first_failed_at = COALESCE(first_failed_at, NOW()),
                    retry_after = CURRENT_DATE + ($4::int * INTERVAL '1 day')
              WHERE id = $1 AND status = 'active' AND next_charge_date = $5::date`,
            [g.id, attempt, reason, wait, dueDate])

          // The donor, privately. Only if we have somewhere to reach them —
          // a recurring gift can be set up without an email.
          if (g.donor_email) {
            // Resolved here rather than left to notify(), because the
            // frequency word has to be translated into the SAME language the
            // body will be rendered in. notify() resolves it again; that is
            // one cheap lookup for a message that only sends on a failure.
            const donorLang = await languageFor({
              organizationId: g.organization_id, recipient: g.donor_email })
            await notifyQuietly({
              organizationId: g.organization_id,
              recipient: g.donor_email,
              notification_type: 'recurring_gift_needs_attention',
              vars: {
                donor_name:  g.donor_name,
                // Missing entirely before, so the subject read "Your recurring
                // gift to " and the sign-off was a bare em dash — the first
                // thing a donor hears, from a parish they cannot identify.
                church_name: g.church_name,
                frequency:   frequencyWord(g.frequency, donorLang),
                amount:      `$${Number(g.amount).toFixed(2)}`,
                giving_url:  givingUrl(g.org_slug),
              },
            })
          }
        }
      } catch (bookkeeping) {
        monitor.error('recurring.failureBookkeeping', bookkeeping,
          { recurringGiftId: g.id, orgId: g.organization_id })
      }
    } finally {
      client.release()
    }
  }

  // `paused` and `recovered` are the two numbers a person actually wants from
  // this run: how many gifts stopped, and how many came back. `failed` alone
  // could not tell them apart — a card retried on day three and taken on day
  // ten showed up as a failure and then as a charge, with nothing saying it
  // was the same gift recovering.
  return { processed, charged, failed, deduped, paused, recovered }
}
