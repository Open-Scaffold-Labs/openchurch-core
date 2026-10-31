// Synthetic iOS acceptance-pack parish for a throwaway local Postgres.
//
// Fake data only. Creates one parish, bilingual EN/ES members, Mass
// Intentions (sacristy list), events, a draft bulletin, and a least-
// privilege viewer login. Dry-run by default (see acceptancePackGuard).
//
// The caller must already be inside the target gate. This module imports
// the pickup hasher, so the CLI checks the gate before loading it.

import bcrypt from 'bcryptjs'
import {
  resolveAcceptancePack,
  acceptancePackPlan,
  assertAcceptancePackMarker,
} from './acceptancePackGuard.js'
import { thisSundaySpan } from '../utils/sheetWeek.js'
import { genSecurityCode, hashSecurityCode } from '../utils/pickupCode.js'

function refusal(reason, message) {
  const err = new Error(message)
  err.reason = reason
  return err
}

function utcDay(now) {
  return now.toISOString().slice(0, 10)
}

async function insertOrRefuse(db, sql, params, reason, message) {
  try {
    const { rows } = await db.query(sql, params)
    return rows[0]
  } catch (err) {
    if (err?.code === '23505') throw refusal(reason, message)
    throw err
  }
}

export async function seedAcceptancePack(db, env = process.env, options = {}) {
  const resolved = resolveAcceptancePack(env)
  if (!resolved.ok) {
    throw refusal(resolved.reason, `Acceptance pack seed refused: ${resolved.reason}`)
  }

  const plan = acceptancePackPlan(resolved.config)
  if (resolved.dryRun) {
    return {
      seeded: false,
      dryRun: true,
      organizationSlug: resolved.config.orgSlug,
      email: resolved.config.email,
      role: resolved.config.role,
      plan,
      counts: null,
    }
  }

  if (!db || typeof db.query !== 'function') {
    throw refusal('no_database', 'Acceptance pack seed refused: no database client')
  }
  // BEGIN, the advisory lock, every insert, and COMMIT/ROLLBACK must run on
  // one reserved connection. A pg Pool checks out a connection per query,
  // so it cannot hold a transaction. Callers pass `await pool.connect()`.
  if (typeof db.release !== 'function') {
    throw refusal('needs_reserved_client',
      'Acceptance pack seed refused: pass a reserved client (pool.connect()), not a pool')
  }

  // Disposable identity was checked in resolveAcceptancePack. Before any
  // write, require the prepare-script sentinel so openchurch_local (and any
  // unmarked throwaway) cannot be seeded by accident.
  const marker = await assertAcceptancePackMarker(db)
  if (!marker.ok) {
    throw refusal(marker.reason,
      `Acceptance pack seed refused: ${marker.reason} (run prepare-acceptance-pack-db.js on a openchurch_acceptance_* database)`)
  }

  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date()
  const span = thisSundaySpan(utcDay(now))
  if (!span?.sunday) {
    throw refusal('bad_clock', 'Acceptance pack seed refused: could not place this Sunday')
  }

  const { email, password, orgName, orgSlug, userName, role } = resolved.config
  const sunday = span.sunday

  await db.query('BEGIN')
  try {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['openchurch:acceptance-pack-seed'])

    const { rows: orgRows } = await db.query(
      'SELECT id FROM ochr_organizations WHERE slug = $1',
      [orgSlug],
    )
    if (orgRows.length) {
      throw refusal('org_slug_taken',
        `Acceptance pack seed refused: org_slug_taken — '${orgSlug}' already exists. Nothing was written.`)
    }
    const { rows: emailRows } = await db.query(
      'SELECT id FROM ochr_users WHERE lower(email) = $1',
      [email],
    )
    if (emailRows.length) {
      throw refusal('email_taken',
        'Acceptance pack seed refused: email_taken — that email already belongs to a user. Nothing was written.')
    }

    const org = await insertOrRefuse(db,
      `INSERT INTO ochr_organizations (name, slug, org_type, tradition, timezone)
       VALUES ($1, $2, 'parish', 'catholic', 'UTC')
       RETURNING id`,
      [orgName, orgSlug],
      'org_slug_taken',
      `Acceptance pack seed refused: org_slug_taken — '${orgSlug}' was created concurrently. Nothing was written.`,
    )
    const orgId = org.id

    const hash = await bcrypt.hash(password, 10)
    await insertOrRefuse(db,
      `INSERT INTO ochr_users
         (organization_id, email, password_hash, name, role, pastoral_lead, invite_accepted_at)
       VALUES ($1, $2, $3, $4, $5, false, NOW())
       RETURNING id`,
      [orgId, email, hash, userName, role],
      'email_taken',
      'Acceptance pack seed refused: email_taken — that email was taken concurrently. Nothing was written.',
    )

    // Bilingual EN/ES roster. Names and addresses are invented.
    const people = [
      {
        key: 'ada',
        name: 'Synthetic Ada Example',
        email: 'synthetic.ada.en@example.com',
        phone: '(555) 010-2501',
        role: 'Parishioner',
        birth: '1984-03-14',
        joined: '2019-09-08',
        preferred_language: 'en',
      },
      {
        key: 'luis',
        name: 'Synthetic Luis Example',
        email: 'synthetic.luis.es@example.com',
        phone: '(555) 010-2502',
        role: 'Child',
        birth: '2016-04-02',
        joined: '2016-06-12',
        preferred_language: 'es',
      },
      {
        key: 'nora',
        name: 'Synthetic Nora Example',
        email: 'synthetic.nora.both@example.com',
        phone: '(555) 010-2503',
        role: 'Catechist',
        birth: '1979-11-21',
        joined: '2012-01-15',
        preferred_language: 'both',
      },
    ]
    const memberId = {}
    for (const person of people) {
      const row = await db.query(
        `INSERT INTO ochr_clients
           (organization_id, name, email, phone, role, status, birth_date, joined_date,
            preferred_language, notes)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9)
         RETURNING id`,
        [orgId, person.name, person.email, person.phone, person.role, person.birth, person.joined,
          person.preferred_language,
          'Synthetic acceptance-pack fixture. Not a real person.'],
      )
      memberId[person.key] = row.rows[0].id
    }

    await db.query(
      `INSERT INTO ochr_sacramental_records
         (organization_id, client_id, type, date, minister, place, certificate_no, notes, member_name)
       VALUES ($1, $2, 'baptism', '2016-06-12', $3, $4, 'SYN-AP-B-0001', $5, $6)`,
      [orgId, memberId.luis, 'Synthetic Minister Example', orgName,
        'Synthetic acceptance-pack fixture. Not a real person.', 'Synthetic Luis Example'],
    )

    const cal = await db.query(
      `INSERT INTO ochr_calendar_events
         (organization_id, title, date, start_time, end_time, type)
       VALUES ($1, 'Synthetic Sunday Mass', $2, '10:00', '11:00', 'service')
       RETURNING id`,
      [orgId, sunday],
    )
    const calendarEventId = cal.rows[0].id

    const ev = await db.query(
      `INSERT INTO ochr_events
         (organization_id, title, service_division, date, time, location, is_public)
       VALUES ($1, 'Synthetic Sunday Mass', 'Worship', $2, '10:00', 'Synthetic Church', false)
       RETURNING id`,
      [orgId, sunday],
    )
    await db.query(
      `INSERT INTO ochr_event_members (event_id, organization_id, member_id)
       VALUES ($1, $2, $3)`,
      [ev.rows[0].id, orgId, memberId.nora],
    )

    await db.query(
      `INSERT INTO ochr_mass_intentions
         (organization_id, intention, requested_by, requested_by_client_id, mass_date,
          stipend, status, note, calendar_event_id)
       VALUES ($1, $2, $3, $4, $5, 10.00, 'scheduled', $6, $7)`,
      [orgId, '+Synthetic Casey Example', 'Synthetic Ada Example', memberId.ada, sunday,
        'Synthetic acceptance-pack fixture. Not a real person.', calendarEventId],
    )

    // Hash only. The plaintext code is discarded and never returned.
    const pickupHash = hashSecurityCode(genSecurityCode())
    await db.query(
      `INSERT INTO ochr_checkins
         (organization_id, calendar_event_id, client_id, person_name, kind, guardian_name,
          security_code_hash, attended_date, attended_title, attended_time)
       VALUES ($1, $2, $3, $4, 'child', $5, $6, $7, 'Synthetic Sunday Mass', '10:00')`,
      [orgId, calendarEventId, memberId.luis, 'Synthetic Luis Example',
        'Synthetic Ada Example', pickupHash, sunday],
    )

    // Draft bulletin (unpublished). Fake text only. The viewer review login
    // cannot call /api/bulletins (admin-only); the row is for inventory and
    // for a future staff/admin walkthrough on the same throwaway org.
    await db.query(
      `INSERT INTO ochr_bulletins
         (organization_id, date, title, announcements, readings, intentions, pastor_note, published)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`,
      [
        orgId,
        sunday,
        'Synthetic Sunday Bulletin',
        'Synthetic parish announcements. Not a real parish.',
        'Wis 3:1-9; Rom 5:5-11; Jn 15:9-17',
        '+Synthetic Casey Example — requested by Synthetic Ada Example',
        'Synthetic pastor note. Not a real person.',
      ],
    )

    const sacristy = await db.query(
      `SELECT COUNT(*)::int AS n
         FROM ochr_sacristy_weekly_manifest
        WHERE organization_id = $1
          AND mass_date = $2`,
      [orgId, sunday],
    )

    const langs = await db.query(
      `SELECT preferred_language, COUNT(*)::int AS n
         FROM ochr_clients
        WHERE organization_id = $1
        GROUP BY preferred_language
        ORDER BY preferred_language`,
      [orgId],
    )

    await db.query('COMMIT')
    return {
      seeded: true,
      dryRun: false,
      organizationId: orgId,
      organizationSlug: orgSlug,
      email,
      role,
      sunday,
      plan,
      counts: {
        members: people.length,
        register: 1,
        intentions: 1,
        sacristy: sacristy.rows[0].n,
        checkins: 1,
        events: 1,
        calendarEvents: 1,
        bulletins: 1,
        preferredLanguages: Object.fromEntries(langs.rows.map((r) => [r.preferred_language, r.n])),
      },
    }
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}
