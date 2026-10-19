// RUNTIME-L2-11 — classify authenticated `/clients/1` HTTP 400.
//
// The SPA path is not the API. GET /api/clients/:id returns 400 only when
// requireIntParam rejects the :id. The digit "1" is a valid SERIAL id, so
// that route cannot answer 400 for /api/clients/1. Missing rows are 404.
// Mutate parseIntId('1') or the GET handler's requireIntParam and these
// tests go red.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseIntId, requireIntParam } from '../src/utils/params.js'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENTS_SRC = readFileSync(join(here, '../src/routes/clients.js'), 'utf8')

function mockRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (body) => { res.body = body; return res }
  return res
}

describe('RUNTIME-L2-11 /api/clients/:id cannot 400 on id=1', () => {
  it('parseIntId("1") is the integer 1', () => {
    expect(parseIntId('1')).toBe(1)
    expect(parseIntId(1)).toBe(1)
  })

  it('requireIntParam accepts 1 and does not write 400', () => {
    const res = mockRes()
    expect(requireIntParam({ params: { id: '1' } }, res)).toBe(1)
    expect(res.statusCode).toBeNull()
  })

  it('requireIntParam 400s only garbage ids — not the digit 1', () => {
    for (const bad of ['', 'abc', '1.5', '-1', '1e3', '0', '1/']) {
      const res = mockRes()
      expect(requireIntParam({ params: { id: bad } }, res), bad).toBeNull()
      expect(res.statusCode, bad).toBe(400)
      expect(res.body.error).toMatch(/Invalid/i)
    }
  })

  it('GET /:id uses requireIntParam and 404s a missing row — never 400 after a valid parse', () => {
    const get = CLIENTS_SRC.slice(
      CLIENTS_SRC.indexOf('// GET /api/clients/:id'),
      CLIENTS_SRC.indexOf('// GET /api/clients/:id/donations'),
    )
    expect(get).toMatch(/requireIntParam\(req, res\)/)
    expect(get).toMatch(/res\.status\(404\)\.json\(\{ error: 'Not found' \}\)/)
    expect(get).not.toMatch(/res\.status\(400\)/)
  })
})
