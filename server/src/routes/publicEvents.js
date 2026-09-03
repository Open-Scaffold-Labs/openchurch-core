// Public events feed (Sprint P). Unauthenticated — anyone with the
// URL can see the church's public events. The church's slug is the
// public identifier (set on signup as a URL-safe form of the org
// name). Privacy boundary: every query joins ochr_organizations on
// slug AND filters ochr_events.is_public = TRUE, so a non-public
// event can never bleed through even if the slug leaks.
//
// Three surfaces:
//   GET /api/public/:slug                → org card (name + counts)
//   GET /api/public/:slug/events         → JSON of upcoming public events
//   GET /api/public/:slug/events.ics     → ICS subscription feed
//
// Cache: 5 min private for the JSON, 1 hour for the ICS (calendar
// apps poll every ~hour and beating that down hurts our DB without
// helping parishioners). 404 stays uncached.

import { Router } from 'express'
import { isEmail } from './auth.js'
import rateLimit from 'express-rate-limit'
import ical from 'ical-generator'
import pool from '../db.js'
import { normalizeDonorEmail } from '../finance/donorIdentity.js'
import { createCharge, createDonationCheckout, paymentsConfigured, paymentsProvider, stubWouldFakeMoney } from '../payments/index.js'
import { notify } from '../notifications/transport.js'
import { monitor } from '../monitoring/index.js'
import { resolveLiturgicalContext } from './liturgical.js'

const router = Router()

// This router predates the i18n message helper and returns bare { error }
// objects everywhere. Keeping that shape rather than introducing a second
// one for a single response.
const msgOrPlain = text => ({ error: text })

// Online-giving submit limiter (GIV.1) — 15 per IP per 10 min. Covers a
// donor correcting a typo and re-submitting without letting a card-
// testing bot hammer the charge path.
const giveLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many attempts from this address. Please try again in a few minutes.' },
})

// Connect-card submit limiter (CC.1) — 10 per IP per 10 min. A
// visitor signing up for a ministry or two is fine; a bot wave hits
// the wall before flooding the admin's interest queue. Scoped to the
// POST so the GET groups list stays uncapped.
const connectLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many submissions from this address. Please try again in a few minutes.' },
})

// Lookup the org row by slug. Returns null on miss so callers can
// 404 cleanly.
async function findOrgBySlug(slug) {
  if (!slug || typeof slug !== 'string') return null
  const { rows } = await pool.query(
    'SELECT id, name, slug, locale FROM ochr_organizations WHERE slug = $1 LIMIT 1',
    [slug]
  )
  return rows[0] ?? null
}

// Convert a YYYY-MM-DD + 'HH:MM:SS' into a JS Date the way the
// existing calendar-sync feed does. Postgres TIME columns come back
// as 'HH:MM:SS' and we want minute precision in the ICS event.
function toDateOnly(d) {
  if (!d) return null
  return d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
}

function startDateFor(event) {
  const datePart = toDateOnly(event.date)
  const rawTime  = event.time ? String(event.time) : '00:00'
  const hhmm     = rawTime.slice(0, 5)
  return new Date(`${datePart}T${hhmm}:00`)
}

// GET /api/public/:slug
// Lightweight org card — name + public-event count. Used by the
// parishioner-facing /p/:slug/events page header.
router.get('/:slug', async (req, res) => {
  try {
    const org = await findOrgBySlug(req.params.slug)
    if (!org) return res.status(404).json({ error: 'Church not found' })

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_events
        WHERE organization_id = $1
          AND is_public = TRUE
          AND date >= CURRENT_DATE`,
      [org.id]
    )
    res.set('Cache-Control', 'public, max-age=300')
    res.json({ name: org.name, slug: org.slug, upcoming_count: rows[0].n })
  } catch (err) {
    console.error('public org failed:', err)
    res.status(500).json({ error: 'Failed to load church' })
  }
})

// GET /api/public/:slug/page
// Public church homepage content (Anchor 5 / A5.1). Gated on
// page_published: an unpublished (or non-existent) church returns the
// same 404, so a draft page can't be discovered by probing the slug.
// Location reuses the org's letterhead `address`.
router.get('/:slug/page', async (req, res) => {
  try {
    const { rows } = await pool.query(
      // THIRD hand-listed org column list in this file — the two helpers
      // above are the other two. That is exactly how a field goes missing:
      // `locale` was added to both helpers and this query still returned
      // English, and the test that asserts the class caught it rather than
      // a reviewer noticing a third query fifteen lines further down.
      `SELECT name, slug, tagline, about, service_times, address, page_published, locale
         FROM ochr_organizations
        WHERE slug = $1
        LIMIT 1`,
      [req.params.slug]
    )
    const org = rows[0]
    if (!org || !org.page_published) {
      return res.status(404).json({ error: 'Church page not found' })
    }

    res.set('Cache-Control', 'public, max-age=300')
    res.json({
      church: { name: org.name, slug: org.slug, locale: org.locale ?? 'en' },
      page: {
        tagline:       org.tagline,
        about:         org.about,
        service_times: org.service_times,
        address:       org.address,
      },
    })
  } catch (err) {
    console.error('public church page failed:', err)
    res.status(500).json({ error: 'Failed to load church page' })
  }
})

// Resolve a published org by slug → { id, name, slug } or null.
// Connect-card surfaces share the church-page publish gate: if the
// homepage isn't published, the church isn't collecting connect cards.
async function findPublishedOrg(slug) {
  if (!slug || typeof slug !== 'string') return null
  const { rows } = await pool.query(
    'SELECT id, name, slug, locale FROM ochr_organizations WHERE slug = $1 AND page_published = TRUE LIMIT 1',
    [slug]
  )
  return rows[0] ?? null
}

// GET /api/public/:slug/groups
// The church's groups, for the connect card's ministry picker. Names +
// categories + descriptions only — never rosters. Gated on the page
// being published.
router.get('/:slug/groups', async (req, res) => {
  try {
    const org = await findPublishedOrg(req.params.slug)
    if (!org) return res.status(404).json({ error: 'Church not found' })

    const { rows } = await pool.query(
      `SELECT id, name, category, description
         FROM ochr_groups
        WHERE organization_id = $1
        ORDER BY name ASC`,
      [org.id]
    )
    res.set('Cache-Control', 'public, max-age=300')
    res.json({ church: { name: org.name, slug: org.slug, locale: org.locale ?? 'en' }, groups: rows })
  } catch (err) {
    console.error('public groups failed:', err)
    res.status(500).json({ error: 'Failed to load groups' })
  }
})

// POST /api/public/:slug/connect
//   { group_id?, name, email?, phone?, message? }
// Stores a PENDING interest for admin review — never an auto-add.
// group_id is validated against the org; an unknown/foreign group is
// dropped to null (general interest) rather than 400ing a parishioner.
router.post('/:slug/connect', connectLimiter, async (req, res) => {
  try {
    const org = await findPublishedOrg(req.params.slug)
    if (!org) return res.status(404).json({ error: 'Church not found' })

    const name    = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const email   = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
    const phone   = typeof req.body?.phone === 'string' ? req.body.phone.trim() : ''
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    if (!name)            return res.status(400).json({ error: 'Name is required' })
    if (name.length > 120) return res.status(400).json({ error: 'Name is too long' })
    if (email.length > 200 || phone.length > 40 || message.length > 1000) {
      return res.status(400).json({ error: 'One of your fields is too long' })
    }

    // Validate group_id belongs to this org; otherwise treat as a
    // general interest (null) so a stale picker doesn't reject a real
    // parishioner.
    let groupId = Number(req.body?.group_id)
    if (Number.isInteger(groupId) && groupId > 0) {
      const { rows } = await pool.query(
        'SELECT 1 FROM ochr_groups WHERE id = $1 AND organization_id = $2',
        [groupId, org.id]
      )
      if (!rows.length) groupId = null
    } else {
      groupId = null
    }

    await pool.query(
      `INSERT INTO ochr_group_interests
         (organization_id, group_id, name, email, phone, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [org.id, groupId, name, email || null, phone || null, message || null]
    )
    // Minimal response — the public page just needs the success signal.
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('public connect failed:', err)
    res.status(500).json({ error: 'Failed to submit' })
  }
})

// GET /api/public/:slug/funds
// Active giving funds for the public give page. A church with no active
// funds returns an empty list — the give page reads that as "giving
// isn't set up yet".
router.get('/:slug/funds', async (req, res) => {
  try {
    const org = await findOrgBySlug(req.params.slug)
    if (!org) return res.status(404).json({ error: 'Church not found' })

    const { rows } = await pool.query(
      `SELECT id, name, description
         FROM ochr_funds
        WHERE organization_id = $1 AND active = TRUE
        ORDER BY sort_order ASC, name ASC`,
      [org.id]
    )
    // `giving_enabled` so the page can show its existing "not set up yet"
    // state instead of rendering a form whose submit will be refused. The
    // refusal in POST /give is the guard; this is so a parishioner never
    // meets it.
    res.set('Cache-Control', 'public, max-age=120')
    res.json({
      church: { name: org.name, slug: org.slug, locale: org.locale ?? 'en' },
      funds: rows,
      giving_enabled: paymentsConfigured(),
    })
  } catch (err) {
    console.error('public funds failed:', err)
    res.status(500).json({ error: 'Failed to load funds' })
  }
})

// POST /api/public/:slug/give
//   { fund_id, amount, donor_name, donor_email?, message? }
// Runs the charge through the vendor-neutral payments stub, then records
// it as an ordinary ochr_donations row (method/source 'online') so it
// shows up in stats + year-end statements. The fund must be one of the
// church's active funds.
router.post('/:slug/give', giveLimiter, async (req, res) => {
  try {
    const org = await findOrgBySlug(req.params.slug)
    if (!org) return res.status(404).json({ error: 'Church not found' })

    const donorName  = typeof req.body?.donor_name === 'string' ? req.body.donor_name.trim() : ''
    // Normalised at the boundary, so the address this donor is known by
    // does not depend on whether they capitalised it. isEmail() below
    // validates the normalised form, which is also what gets stored and
    // what the year-end statement will group on.
    const donorEmail = normalizeDonorEmail(req.body?.donor_email) ?? ''
    const message    = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    const amount     = Number(req.body?.amount)
    const fundId     = Number(req.body?.fund_id)
    // Optional recurring setup (GIV.7). Anything other than weekly/monthly
    // is treated as a one-time gift.
    const frequency  = ['weekly', 'monthly'].includes(req.body?.frequency) ? req.body.frequency : null

    // Every text field is bounded. The /connect route in this same file has
    // always capped its fields; this one capped only the email's LENGTH and
    // let name and message through unbounded — 200,000 characters of each
    // were stored from a single unauthenticated request on 23 Aug.
    if (!donorName) return res.status(400).json({ error: 'Name is required' })
    if (donorName.length > 120) return res.status(400).json({ error: 'Name is too long' })
    if (message.length > 1000) return res.status(400).json({ error: 'Note is too long' })
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' })
    if (amount > 100000) return res.status(400).json({ error: 'Amount exceeds the online limit' })
    if (donorEmail.length > 200) return res.status(400).json({ error: 'Email is too long' })
    // An address, not just a short string. This value is handed to notify()
    // as the recipient of the receipt, so the day an email provider is
    // configured an unvalidated value here chooses who receives mail from the
    // parish's own verified domain. Optional — a donor may give without one —
    // but if given it has to be an address.
    if (donorEmail && !isEmail(donorEmail)) {
      return res.status(400).json({ error: 'That email address does not look right' })
    }

    const { rows: funds } = await pool.query(
      'SELECT id, name FROM ochr_funds WHERE id = $1 AND organization_id = $2 AND active = TRUE',
      [fundId, org.id]
    )
    if (!funds.length) return res.status(400).json({ error: 'Choose a fund to give to' })
    const fund = funds[0]

    // Round to cents before the money boundary to avoid float drift.
    const dollars = Math.round(amount * 100) / 100

    // Live Stripe → hosted Checkout. The browser is redirected to
    // Stripe's page; the donation row + receipt are written by the
    // webhook when the session completes, never before money moved.
    // (Recurring online gifts stay stub-only until saved-card charging
    // is enabled — fail clearly rather than half-subscribe someone.)
    if (paymentsProvider() === 'stripe') {
      if (frequency) {
        return res.status(400).json({ error: 'Recurring online gifts are coming soon — choose a one-time gift for now.' })
      }
      const base = (process.env.CLIENT_URL || 'http://localhost:5202').replace(/\/$/, '')
      try {
        const { url } = await createDonationCheckout({
          organizationId: org.id,
          amount: dollars,
          fundId: fund.id,
          fundName: fund.name,
          donorName,
          donorEmail: donorEmail || undefined,
          message: message || undefined,
          successUrl: `${base}/p/${req.params.slug}/give?success=1`,
          cancelUrl:  `${base}/p/${req.params.slug}/give?canceled=1`,
        })
        return res.json({ checkout_url: url })
      } catch {
        return res.status(502).json({ error: 'Payment could not be started. No charge was made.' })
      }
    }

    // No provider configured means no money can actually move — and a
    // donation row written on the strength of a synthetic "succeeded" is a
    // record of a gift nobody made. It reaches the dashboard, the finance
    // summary, the diocesan assessable base, and the donor's year-end tax
    // statement, and it does all of that from ONE unauthenticated request to
    // a slug that is just the parish's name. This route is public by design;
    // that is the point of a giving page. What it must not be is a way to
    // write into a parish's books for free.
    //
    // The stub stays exactly as it is for tests and for the recurring cron,
    // which call createCharge() directly. It is this route — the public,
    // unauthenticated one — that refuses.
    if (!paymentsConfigured()) {
      return res.status(503).json(msgOrPlain(
        'Online giving is not set up for this church yet. Nothing was charged.'))
    }

    // AND a chosen stub is still not money, on a deployment that is real.
    //
    // paymentsConfigured() above answers "did anybody choose?". Somebody
    // choosing the stub on production is a choice, and it would sail
    // through — chargeStub() returns a synthetic succeeded charge, the row
    // below is written, and this page thanks a stranger for a gift the
    // parish will never receive. The deployment, not the caller, decides
    // whether that is allowed; see deploymentIsProductionLike() for what
    // "real" is read from, which is deliberately not NODE_ENV.
    //
    // The message is the unconfigured one on purpose. To the visitor those
    // two states are the same fact — this parish cannot take a gift here
    // right now — and the difference between them is an operator's problem,
    // not something to explain on a giving page. The operator's channel is
    // the monitor line and /api/health's payments_safe.
    if (stubWouldFakeMoney()) {
      monitor.error('payments.stub_on_production', new Error(
        'PAYMENTS_PROVIDER=stub on a production-like deployment: the public give route refused. '
        + 'A stub charge must never be recorded as a received gift.'
      ), { slug: req.params.slug })
      return res.status(503).json(msgOrPlain(
        'Online giving is not set up for this church yet. Nothing was charged.'))
    }

    let charge
    try {
      charge = await createCharge({
        organizationId: org.id,
        amount: dollars,
        currency: 'usd',
        donorName,
        donorEmail: donorEmail || undefined,
        metadata: { fund_id: fund.id, fund: fund.name },
      })
    } catch {
      return res.status(402).json({ error: 'Payment could not be processed. No charge was made.' })
    }

    await pool.query(
      `INSERT INTO ochr_donations
         (organization_id, donor_name, donor_email, amount, category, method, date,
          source, fund_id, payment_ref, payment_status, notes)
       VALUES ($1, $2, $3, $4, $5, 'online', CURRENT_DATE, 'online', $6, $7, $8, $9)`,
      [org.id, donorName, donorEmail || null, dollars, fund.name, fund.id, charge.id, charge.status, message || null]
    )

    // Set up the recurring schedule (GIV.7) — the gift above is the first
    // charge; a cron picks up later cycles from next_charge_date.
    if (frequency) {
      const step = frequency === 'weekly' ? "INTERVAL '7 days'" : "INTERVAL '1 month'"
      await pool.query(
        `INSERT INTO ochr_recurring_gifts
           (organization_id, fund_id, donor_name, donor_email, amount, frequency, next_charge_date)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE + ${step})`,
        [org.id, fund.id, donorName, donorEmail || null, dollars, frequency]
      )
    }

    // Email the donor a receipt (GIV.5) — through the vendor-neutral
    // notify() transport, so it logs/Pushes now and emails the moment a
    // transport is wired. Only when an email was given.
    if (donorEmail) {
      try {
        await notify({
          organizationId:    org.id,
          recipient:         donorEmail,
          notification_type: 'donation_receipt',
          vars: {
            donor_name:  donorName,
            church_name: org.name,
            amount:      `$${dollars.toFixed(2)}`,
            fund:        fund.name,
            date:        new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
            reference:   charge.id,
          },
        })
      } catch (err) {
        console.error('donation receipt notify failed:', err)
      }
    }

    res.status(201).json({
      ok: true,
      receipt: { amount: dollars, fund: fund.name, reference: charge.id, recurring: frequency },
    })
  } catch (err) {
    console.error('public give failed:', err)
    res.status(500).json({ error: 'Failed to process gift' })
  }
})

// GET /api/public/:slug/events
// Upcoming public events for an org, ordered by date ASC then time.
// Hard-caps at 100 rows so a misuse (admin marking 10,000 events
// public) doesn't return a multi-MB blob.
router.get('/:slug/events', async (req, res) => {
  try {
    const org = await findOrgBySlug(req.params.slug)
    if (!org) return res.status(404).json({ error: 'Church not found' })

    const { rows } = await pool.query(
      `SELECT id, title, service_division, date, time, location,
              liturgical_season, liturgical_color, feast_name
         FROM ochr_events
        WHERE organization_id = $1
          AND is_public = TRUE
          AND date >= CURRENT_DATE
        ORDER BY date ASC, time ASC NULLS LAST
        LIMIT 100`,
      [org.id]
    )

    res.set('Cache-Control', 'public, max-age=300')
    res.json({
      church: { name: org.name, slug: org.slug, locale: org.locale ?? 'en' },
      events: rows,
    })
  } catch (err) {
    console.error('public events failed:', err)
    res.status(500).json({ error: 'Failed to load events' })
  }
})

// GET /api/public/:slug/events.ics
// ICS subscription feed. Calendar apps (Apple, Google) poll this
// roughly hourly so the 1h max-age matches the natural cadence
// without leaning on stale data when admins toggle visibility.
router.get('/:slug/events.ics', async (req, res) => {
  try {
    const org = await findOrgBySlug(req.params.slug)
    if (!org) return res.status(404).send('Church not found')

    const { rows } = await pool.query(
      `SELECT id, title, service_division, date, time, location
         FROM ochr_events
        WHERE organization_id = $1
          AND is_public = TRUE
          AND date >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY date ASC, time ASC NULLS LAST
        LIMIT 500`,
      [org.id]
    )

    // Include 7 days of past events so a Sunday-morning subscriber
    // can still see the previous week — calendar apps prefer a small
    // backfill to a hard 'today onward' cliff.
    const calendar = ical({ name: `${org.name} — Public events` })
    for (const ev of rows) {
      if (!ev.date) continue
      const start = startDateFor(ev)
      const end   = new Date(start.getTime() + 60 * 60 * 1000) // 1h block — events.time has no end_time column
      calendar.createEvent({
        start,
        end,
        summary:     ev.title,
        location:    ev.location || '',
        description: ev.service_division || '',
      })
    }

    res.set('Cache-Control', 'public, max-age=3600')
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', `inline; filename="${org.slug}_events.ics"`)
    res.send(calendar.toString())
  } catch (err) {
    console.error('public events.ics failed:', err)
    res.status(500).send('Failed to generate calendar')
  }
})

// GET /api/public/:slug/bulletin
// The parish's most recent PUBLISHED bulletin, read-online (BUL.3b).
// Privacy boundary: only published rows are exposed — a draft 404s the
// same as a missing one. The liturgical day is computed server-side (the
// public reader has no auth to hit /api/liturgical). Internal calendar
// events are intentionally NOT included here; the bulletin shows only
// what the admin wrote plus the liturgical context.
router.get('/:slug/bulletin', async (req, res) => {
  try {
    const org = await findOrgBySlug(req.params.slug)
    if (!org) return res.status(404).json({ error: 'Bulletin not found' })

    const { rows } = await pool.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, announcements,
              readings, intentions, pastor_note, updated_at
         FROM ochr_bulletins
        WHERE organization_id = $1 AND published = TRUE
        ORDER BY date DESC
        LIMIT 1`,
      [org.id]
    )
    const bulletin = rows[0]
    if (!bulletin) return res.status(404).json({ error: 'Bulletin not found' })

    const liturgical = await resolveLiturgicalContext(bulletin.date, org.id)

    res.set('Cache-Control', 'public, max-age=300')
    res.json({ org: { name: org.name, slug: org.slug, locale: org.locale ?? 'en' }, bulletin, liturgical })
  } catch (err) {
    console.error('public bulletin failed:', err)
    res.status(500).json({ error: 'Failed to load bulletin' })
  }
})

export default router
