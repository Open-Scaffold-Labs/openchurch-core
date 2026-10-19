// OC-READY-01-014 — CSP Report-Only + Permissions-Policy on API responses
// and the static-shell vercel.json copies.
//
// Proves the headers are present on / and /api/health, that Enforce is
// absent, and that the Vercel HTML/shell copies match the server strings.
// Does not touch session/cookie auth.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'

import pool from '../src/db.js'
import { bindServer, closeServer, migrateOnce } from './support/harness.js'
import {
  CONTENT_SECURITY_POLICY_REPORT_ONLY,
  PERMISSIONS_POLICY,
  REFERRER_POLICY,
} from '../src/security/browserPolicies.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')

let server

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

function vercelHeaderValues(config, key) {
  return (config.headers || [])
    .flatMap(block => block.headers || [])
    .filter(h => h.key === key)
    .map(h => h.value)
}

function loadVercel(rel) {
  return JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'))
}

describe('OC-READY-01-014 browser policy headers', () => {
  it.each(['/', '/api/health'])(
    '%s sends CSP Report-Only + Permissions-Policy and never an app Enforce policy',
    async (path) => {
      const res = await request(server).get(path)
      expect(res.headers['content-security-policy-report-only']).toBe(
        CONTENT_SECURITY_POLICY_REPORT_ONLY,
      )
      expect(res.headers['permissions-policy']).toBe(PERMISSIONS_POLICY)
      expect(res.headers['referrer-policy']).toBe(REFERRER_POLICY)

      const enforce = res.headers['content-security-policy']
      if (path === '/api/health') {
        expect([200, 503]).toContain(res.status)
        // JSON health is our route: no Enforce header at all.
        expect(enforce).toBeUndefined()
        return
      }

      // GET / is not a served route on the API app (the HTML shell is
      // Vercel static). Express finalhandler then writes a tiny HTML 404
      // and sandboxes it with Content-Security-Policy: default-src 'none'
      // (node_modules/finalhandler). That is not an app-wide Enforce
      // policy and is not set from app.js. Anything else here is a miss.
      expect(res.status).toBe(404)
      if (enforce !== undefined) {
        expect(enforce).toBe("default-src 'none'")
      }
    },
  )

  it('app.js never names the Enforce header', () => {
    const src = readFileSync(join(here, '../src/app.js'), 'utf8')
    expect(src).toMatch(/Content-Security-Policy-Report-Only/)
    expect(src).not.toMatch(/['"]Content-Security-Policy['"]/)
  })

  it('parish and diocese vercel.json match the server policy and exclude /api', () => {
    for (const rel of ['vercel.json', 'client-diocese/vercel.json']) {
      const config = loadVercel(rel)
      const sources = (config.headers || []).map(b => b.source)
      expect(sources, rel).toContain('/((?!api/).*)')
      expect(vercelHeaderValues(config, 'Content-Security-Policy-Report-Only')).toEqual([
        CONTENT_SECURITY_POLICY_REPORT_ONLY,
      ])
      expect(vercelHeaderValues(config, 'Permissions-Policy')).toEqual([
        PERMISSIONS_POLICY,
      ])
      expect(vercelHeaderValues(config, 'Referrer-Policy')).toEqual([
        REFERRER_POLICY,
      ])
      expect(vercelHeaderValues(config, 'Content-Security-Policy')).toEqual([])
    }
  })

  it('parish and diocese shells set the same referrer policy', () => {
    for (const rel of ['client/index.html', 'client-diocese/index.html']) {
      const html = readFileSync(join(repoRoot, rel), 'utf8')
      expect(html, rel).toContain(`<meta name="referrer" content="${REFERRER_POLICY}"`)
    }
  })
})
