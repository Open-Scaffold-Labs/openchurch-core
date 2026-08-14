#!/usr/bin/env node
//
// Seeds the St. Brigid's demo parish. Run before a demo, not in production.
//
//   node server/src/demo/seedStBrigids.js --org 3
//   node server/src/demo/seedStBrigids.js --org 3 --force
//
// ── THE GUARD, AND WHY IT IS SHAPED THIS WAY ─────────────────────────
//
// This script DELETES the target organisation's members, register,
// intentions, calendar and giving before re-seeding, because a demo fixture
// that isn't idempotent drifts after the second run and you find out on
// stage. Destructive + idempotent means the guard has to be real.
//
// The guard is on the ORGANISATION, not on row markers. Marking rows the
// way sampleSeed marks "[Sample]" is wrong here for two reasons: the demo
// has to look untouched (a certificate that prints "[Sample] Nora Doyle"
// is worthless), and the clear-samples endpoint would wipe the demo.
//
// So: refuse unless the org's name matches the demo parish, AND refuse if
// the org holds sacramental records this fixture did not write. The second
// check is the one that matters — the register is a quasi-legal instrument
// and the whole product promise is custody. A seeder that can eat a real
// parish's baptism book would be the single worst bug this codebase could
// ship. --force still requires the name to match; there is no flag that
// lets this run against an arbitrary org.

import pool from '../db.js'
import { PARISH, CLERGY, FAMILIES, REGISTER, MEMBERS, INTENTIONS, WEEKLY, ministerFor } from './stBrigids.js'

const arg = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = flag => process.argv.includes(flag)

const orgId = Number(arg('--org'))
const force = has('--force')

// ── Date helpers ─────────────────────────────────────────────────────
// The fixture is anchored to "today" so the intention book and the week's
// services are always current — a demo where the last service was in March
// tells the rector this is a mock-up.
const iso = d => d.toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const TODAY = new Date()
// Sunday of the current week, so WEEKLY's day-of-week offsets land right.
const SUNDAY = addDays(TODAY, -TODAY.getDay())

// Certificate numbers run per book, in date order — B-0001, M-0031, …
// A register whose numbers are random is a register nobody kept.
const BOOK_PREFIX = {
  baptism: 'B', confirmation: 'C', marriage: 'M', first_communion: 'FC',
  anointing: 'A', reconciliation: 'R', holy_orders: 'HO',
}

function personIndex() {
  const byKey = {}
  for (const fam of FAMILIES) for (const p of fam.people) byKey[p.key] = p
  return byKey
}

async function assertSafe(db) {
  const { rows } = await db.query('SELECT id, name FROM ochr_organizations WHERE id = $1', [orgId])
  if (!rows.length) throw new Error(`Organisation ${orgId} does not exist.`)
  const org = rows[0]

  if (org.name !== PARISH.name) {
    throw new Error(
      `REFUSING TO SEED.\n` +
      `  Organisation ${orgId} is named "${org.name}".\n` +
      `  This seeder only runs against "${PARISH.name}".\n\n` +
      `  It deletes the target org's members, register and intentions. Pointing it\n` +
      `  at a real parish would destroy a sacramental register, so the name check\n` +
      `  is not overridable — not even with --force.\n\n` +
      `  Create the demo org first (sign up as "${PARISH.name}"), then pass its id.`
    )
  }

  const { rows: [{ count }] } = await db.query(
    `SELECT COUNT(*)::int AS count FROM ochr_sacramental_records WHERE organization_id = $1`, [orgId])
  if (count > 0 && !force) {
    throw new Error(
      `Organisation ${orgId} already holds ${count} sacramental record(s).\n` +
      `  Re-run with --force to wipe and re-seed the demo parish.`
    )
  }
  return org
}

async function seed() {
  if (!Number.isInteger(orgId) || orgId <= 0) {
    console.error('Usage: node server/src/demo/seedStBrigids.js --org <id> [--force]')
    process.exit(1)
  }

  const db = await pool.connect()
  try {
    const org = await assertSafe(db)
    await db.query('BEGIN')

    // ── Wipe (scoped to this org, every statement) ──
    for (const table of [
      'ochr_mass_intentions', 'ochr_sacramental_records', 'ochr_event_members',
      'ochr_calendar_events', 'ochr_events', 'ochr_donations', 'ochr_clients',
    ]) {
      await db.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId])
    }

    // ── Members ──
    const memberId = {}
    for (const m of MEMBERS) {
      const { rows: [row] } = await db.query(
        `INSERT INTO ochr_clients (organization_id, name, role, tags, birth_date, joined_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING id`,
        [orgId, m.name, m.role, m.tags, m.born, m.joined])
      memberId[m.name] = row.id
    }

    // ── The register ──
    // Sorted by date so certificate numbers come out in book order.
    const people = personIndex()
    const counters = {}
    const ordered = [...REGISTER].sort((a, b) => a.date.localeCompare(b.date))
    let registerCount = 0
    const firstBaptismOf = {}

    for (const r of ordered) {
      const subject = people[r.who]
      if (!subject) throw new Error(`Unknown register subject: ${r.who}`)

      const prefix = BOOK_PREFIX[r.t] ?? 'X'
      counters[prefix] = (counters[prefix] ?? 0) + 1
      const cert = r.cert ?? `${prefix}-${String(counters[prefix]).padStart(4, '0')}`

      // Link to a living member where the name still matches the roster.
      // Historical subjects who are dead or married-out simply don't link —
      // which is correct, and demonstrates that the register survives
      // independently of the membership list (client_id is ON DELETE SET NULL).
      const linked = memberId[subject.name] ?? null

      const meta = {}
      if (r.godparents) meta.godparents = r.godparents
      if (r.sponsors)   meta.sponsors   = r.sponsors

      const spouseName = r.spouseName ?? (r.spouse ? people[r.spouse]?.name : null)
      const notes = [
        r.t === 'marriage' && spouseName ? `Married to ${spouseName}.` : null,
        r.approx ? 'Date approximate — transcribed from a damaged entry.' : null,
        r.note ?? null,
      ].filter(Boolean).join(' ')

      await db.query(
        `INSERT INTO ochr_sacramental_records
           (organization_id, client_id, type, date, minister, place, certificate_no, notes, meta_attributes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [orgId, linked, r.t, r.date, ministerFor(r.date), r.place ?? PARISH.name,
         cert, notes || null, JSON.stringify(meta)])

      if (r.t === 'baptism' && !firstBaptismOf[r.who]) firstBaptismOf[r.who] = true
      registerCount++
    }

    // ── The week's services (calendar + the events roster) ──
    let serviceCount = 0
    for (let week = -1; week <= 2; week++) {
      for (const s of WEEKLY) {
        const date = iso(addDays(SUNDAY, week * 7 + s.dow))
        // assigned_to is a jsonb array of member ids — it is what the Sunday
        // Packet resolves "Serving this day" from. Acolytes alternate by week
        // so the rota reads like a rota rather than the same two children
        // every Sunday; the rotation is index-based, not random, so repeated
        // seeds produce the same parish.
        const serving = (s.serving ?? []).filter((_n, i) =>
          s.dow !== 0 || i < 3 || (i + week) % 2 === 0)
        const ids = serving.map(n => memberId[n]).filter(Boolean)
        await db.query(
          `INSERT INTO ochr_calendar_events
             (organization_id, title, date, start_time, end_time, type, liturgical_season, liturgical_color, assigned_to)
           VALUES ($1,$2,$3,$4,$5,'service',$6,$7,$8::jsonb)`,
          [orgId, s.title, date, s.start, s.end, 'Ordinary Time', 'Green', JSON.stringify(ids)])
        serviceCount++
      }
    }
    // The Sunday principal service also lands in the events roster, which is
    // what the assignment/serving flow reads.
    const sundayISO = iso(SUNDAY)
    const { rows: [ev] } = await db.query(
      `INSERT INTO ochr_events (organization_id, title, service_division, date, time, location, liturgical_season, liturgical_color, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING id`,
      [orgId, 'Choral Eucharist, Rite II', 'Worship', sundayISO, '10:30', 'Church', 'Ordinary Time', 'Green'])
    for (const who of ['Robert Alan Whitfield', 'Elena Vargas Ruiz', 'Nora Margaret Doyle',
                       'Jennifer Lynn Ferreira', 'Jason Robert Whitfield']) {
      if (memberId[who]) {
        await db.query(
          `INSERT INTO ochr_event_members (event_id, organization_id, member_id) VALUES ($1,$2,$3)`,
          [ev.id, orgId, memberId[who]])
      }
    }

    // ── The intention book ──
    for (const i of INTENTIONS) {
      const massDate = iso(addDays(TODAY, i.offset))
      await db.query(
        `INSERT INTO ochr_mass_intentions
           (organization_id, intention, requested_by, requested_by_client_id, mass_date, stipend, status, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [orgId, i.intention, i.by, memberId[i.by] ?? null, massDate, i.stipend, i.status, i.note ?? null])
    }

    // ── A little giving history, so Insights isn't a wall of zeros ──
    const CATEGORIES = ['Plate', 'Pledge', 'Altar Flowers', 'Outreach', 'Building Fund']
    let donationCount = 0
    for (let w = 0; w < 26; w++) {
      const date = iso(addDays(SUNDAY, -w * 7))
      for (const m of MEMBERS.slice(2, 14)) {
        // Deterministic pseudo-variation: no Math.random, so two runs of the
        // seeder produce the same parish and screenshots stay reproducible.
        const h = (m.name.length * 31 + w * 17) % 100
        if (h < 35) continue
        const amount = 25 + (h % 8) * 25
        await db.query(
          `INSERT INTO ochr_donations (organization_id, donor_name, amount, category, method, date)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [orgId, m.name, amount, CATEGORIES[h % CATEGORIES.length], h % 3 === 0 ? 'check' : 'cash', date])
        donationCount++
      }
    }

    await db.query('COMMIT')

    console.log(`\n  ${PARISH.name} — ${PARISH.city}, ${PARISH.state} (founded ${PARISH.founded})`)
    console.log(`  organisation ${orgId}\n`)
    console.log(`    ${MEMBERS.length} members on the roster`)
    console.log(`    ${registerCount} sacramental records, ${ordered[0].date} – ${ordered[ordered.length - 1].date}`)
    console.log(`    ${CLERGY.length} rectors, ${CLERGY[0].from}–present`)
    console.log(`    ${INTENTIONS.length} intentions across the current week`)
    console.log(`    ${serviceCount} services over four weeks`)
    console.log(`    ${donationCount} gifts over six months\n`)
    console.log(`  Try: /register  ·  /intentions  ·  /register/<id>/certificate\n`)
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    console.error(`\n${err.message}\n`)
    process.exitCode = 1
  } finally {
    db.release()
    await pool.end()
  }
}

seed()
