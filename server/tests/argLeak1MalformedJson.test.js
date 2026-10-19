// ARG-LEAK-1: malformed JSON must answer 400 and must never write the
// request body (here a canary password) to any console stream.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import { bindServer, closeServer } from './support/harness.js'

let server
beforeAll(async () => { server = await bindServer() })
afterAll(async () => { await closeServer(server) })

function capture() {
  const out = []
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map(k =>
    vi.spyOn(console, k).mockImplementation((...a) => { out.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x, Object.getOwnPropertyNames(x ?? {}))).join(' ')) }))
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out.push(String(c)); return true })
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { out.push(String(c)); return true })
  return { out, restore: () => { spies.forEach(s => s.mockRestore()); so.mockRestore(); se.mockRestore() } }
}

describe('ARG-LEAK-1 malformed JSON body', () => {
  it('returns 400 and never logs the canary password', async () => {
    const canary = 'CanaryPw' + Math.random().toString(36).slice(2, 10)
    const cap = capture()
    let res
    try {
      res = await request(server).post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send(`{"email":"leak1@argus.test","password":${canary}}`)
    } finally { cap.restore() }
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).not.toContain(canary)
    expect(cap.out.join('\n')).not.toContain(canary)
    expect(cap.out.join('\n')).toContain('entity.parse.failed')
  })
})
