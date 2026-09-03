// Admin-only operational endpoints for keeping the database tidy.
// Mounted at /api/admin/maintenance behind requireAuth +
// requireRole('admin') in app.js.
//
// Today the only endpoint here is the retention prune. It's
// operator-poked; once Vercel cron lands, the cron config flips it
// from manual to scheduled (1 line in vercel.json).

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import pool from '../db.js'
import { pruneOldRecords } from '../services/retention.js'
import { monitor } from '../monitoring/index.js'
import { slugify } from './auth.js'

const router = Router()

router.post('/retention-prune', async (req, res) => {
  try {
    const result = await pruneOldRecords()
    res.json(result)
  } catch (err) {
    monitor.error('maintenance.retention-prune', err)
    res.status(500).json({ error: 'Retention prune failed' })
  }
})

// POST /api/admin/maintenance/organizations — provision an organization
// that is NOT self-service.
//
// THE TRUSTED PATH FOR A DIOCESE. Public signup creates parishes and
// refuses everything else (routes/auth.js), because a chancery is a
// relationship with an organisation rather than a customer who arrives with
// a credit card, and an open door let a stranger stamp a diocese and start
// inviting parishes. This is the door instead: mounted behind requireAuth +
// requireSuperAdmin in app.js, so the caller must hold a signed JWT whose
// email equals SUPER_ADMIN_EMAIL. No env var configured means nobody
// qualifies and the whole surface 404s — fail-closed, and the 404 keeps its
// existence unadvertised.
//
// Deliberately NOT an onboarding system. No invitation flow, no email, no
// self-serve chancery signup, no UI. It creates the organization and its
// first admin and stops. Everything else a diocese needs already exists
// once it can sign in.
//
// The founding user of a chancery gets pastoral_lead (CARE.3): a diocese
// whose first account cannot read its own pastoral notes is a chancery
// nobody can work in, and they cannot grant it to themselves before there
// is anybody to grant it. They can withdraw it later.
const ORG_TYPES = new Set(['parish', 'diocese'])
const TRADITIONS = new Set(['catholic', 'episcopal', 'lutheran', 'anglican', 'general'])
const MIN_PASSWORD = 8

router.post('/organizations', async (req, res) => {
  const { organizationName, name, email, password } = req.body ?? {}
  const orgType = ORG_TYPES.has(req.body?.organizationType) ? req.body.organizationType : null
  const tradition = TRADITIONS.has(req.body?.tradition) ? req.body.tradition : 'general'

  if (!orgType) return res.status(400).json({ error: `organizationType must be one of: ${[...ORG_TYPES].join(', ')}` })
  if (!organizationName?.trim()) return res.status(400).json({ error: 'organizationName is required' })
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' })
  if (typeof email !== 'string' || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' })
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD} characters` })
  }

  const cleanEmail = email.trim().toLowerCase()
  const { rows: dupe } = await pool.query(
    `SELECT 1 FROM ochr_users WHERE email = $1
       -- tenancy: pre-tenancy by nature. This call CREATES the organization the
       -- user will belong to, so there is no caller org to scope by yet, and
       -- email is globally unique across the app.`,
    [cleanEmail]
  )
  if (dupe.length) return res.status(409).json({ error: 'An account with that email already exists' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    let slug = slugify(organizationName) || 'organization'
    const { rows: slugDupe } = await client.query('SELECT 1 FROM ochr_organizations WHERE slug = $1', [slug])
    if (slugDupe.length) slug = `${slug}-${Date.now().toString(36).slice(-4)}`

    const { rows: orgRows } = await client.query(
      'INSERT INTO ochr_organizations (name, slug, org_type, tradition) VALUES ($1, $2, $3, $4) RETURNING id, name, slug, org_type',
      [organizationName.trim(), slug, orgType, tradition]
    )
    const org = orgRows[0]

    const hash = await bcrypt.hash(password, 10)
    const { rows: userRows } = await client.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role, pastoral_lead)
       VALUES ($1, $2, $3, $4, 'admin', $5) RETURNING id, email, name, role`,
      [org.id, cleanEmail, hash, name.trim(), orgType === 'diocese']
    )

    await client.query('COMMIT')

    // No token is returned. Provisioning is not signing in — whoever this
    // organization belongs to signs in themselves, which also means the
    // operator never holds a session for a customer's chancery.
    monitor.info?.('maintenance.provision', { orgId: org.id, orgType })
    res.status(201).json({ organization: org, user: userRows[0] })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('maintenance.provision', err)
    res.status(500).json({ error: 'Failed to provision organization' })
  } finally {
    client.release()
  }
})

export default router
