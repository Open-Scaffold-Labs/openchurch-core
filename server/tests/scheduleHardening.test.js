// TARS S398-SCHED-01..03 post-hoc review of 409159d (Dale's direct push).
// Public /api/schedule surface + /.well-known/agent-booking.json must not
// claim bookings it never persists, must bound public input, must not
// trust the Host header, and must not claim a tokenized feed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import request from 'supertest'
import app from '../src/app.js'

const MUTATING = ['schedule.book_slot', 'schedule.create_booking', 'schedule.move_or_cascade', 'schedule.reschedule_cascade']

describe('S398-SCHED-01: no fake confirmations from public MCP', () => {
  for (const tool of MUTATING) {
    it(`${tool} returns not_implemented, never confirmed`, async () => {
      const res = await request(app).post('/api/schedule/mcp').send({ tool, input: { title: 'x' } })
      expect(res.status).toBe(501)
      expect(res.body.status).toBe('not_implemented')
      expect(res.body.ok).toBe(false)
      expect(JSON.stringify(res.body)).not.toContain('confirmed')
    })
  }
  it('discovery flags mutating tools as unavailable', async () => {
    const res = await request(app).get('/api/schedule/mcp')
    for (const name of MUTATING) {
      const t = res.body.tools.find(x => x.name === name)
      expect(t, name).toBeTruthy()
      expect(t.available).toBe(false)
      expect(t.status).toBe('not_implemented')
    }
    expect(res.body.tools.find(x => x.name === 'schedule.check_availability').available).toBe(true)
  })
})

describe('S398-SCHED-02: public POST bounds', () => {
  const big = n => Array.from({ length: n }, (_, i) => ({ role: 'r' + i }))
  it('rejects >200 existing_bookings on /facility-hold', async () => {
    const res = await request(app).post('/api/schedule/facility-hold').send({ existing_bookings: big(201) })
    expect(res.status).toBe(400)
  })
  it('rejects >200 assignments on /volunteer-roster', async () => {
    const res = await request(app).post('/api/schedule/volunteer-roster').send({ assignments: big(201) })
    expect(res.status).toBe(400)
  })
  it('rejects >200 waitlist_entries on /mcp', async () => {
    const res = await request(app).post('/api/schedule/mcp').send({ tool: 'schedule.fill_waitlist', input: { waitlist_entries: big(201) } })
    expect(res.status).toBe(400)
  })
  it('rejects bodies over 32kb with 413', async () => {
    const res = await request(app).post('/api/schedule/volunteer-roster').send({ service_title: 'x'.repeat(40 * 1024) })
    expect(res.status).toBe(413)
  })
  it('still accepts a normal roster', async () => {
    const res = await request(app).post('/api/schedule/volunteer-roster').send({ assignments: big(4) })
    expect(res.status).toBe(200)
  })
})

describe('feed.ics honesty', () => {
  it('is a static sample: ignores org query, no tokenized claim', async () => {
    const res = await request(app).get('/api/schedule/feed.ics?parish=evil-parish-label')
    expect(res.status).toBe(200)
    expect(res.text).not.toContain('evil-parish-label')
    expect(res.text.toLowerCase()).toContain('sample')
    expect(res.headers['x-openchurch-sample']).toBe('true')
  })
})

describe('S398-SCHED-03: agent-booking manifest', () => {
  it('ignores a spoofed Host header and has no org id or payment/booking claims', async () => {
    const res = await request(app).get('/.well-known/agent-booking.json').set('Host', 'attacker.example')
    expect(res.status).toBe(200)
    const s = JSON.stringify(res.body)
    expect(s).not.toContain('attacker.example')
    expect(s).not.toContain('openchurch-parish')
    expect(res.body.org_id).toBeUndefined()
    expect(res.body.payment_rails).toBeUndefined()
    expect(s).not.toMatch(/checkout|create_booking|book_slot|stripe|apple_pay|x_money|voice|dtmf/i)
  })
})

describe('R401-1: 32KB limit enforced at the parsing boundary', () => {
  const http = require('node:http')
  function chunkedPost(server, path, payload) {
    return new Promise((resolve, reject) => {
      const { port } = server.address()
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => {
        let body = ''; res.on('data', d => { body += d }); res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      req.on('error', reject)
      for (let i = 0; i < payload.length; i += 4096) req.write(payload.slice(i, i + 4096))
      req.end()
    })
  }
  let server
  beforeAll(async () => { await new Promise(r => { server = app.listen(0, '127.0.0.1', r) }) })
  afterAll(async () => { await new Promise(r => server.close(r)) })

  for (const path of ['/api/schedule/facility-hold', '/api/schedule/volunteer-roster', '/api/schedule/mcp']) {
    it(`${path}: chunked >32KB with no Content-Length -> 413`, async () => {
      // 40KB of whitespace around a tiny valid object: raw bytes > 32KB but the
      // parsed body is tiny, so only a parsing-boundary limit (not a post-parse
      // size estimate after the 10MB global parser consumed it) can reject it.
      const payload = '{"tool":"schedule.check_availability"' + ' '.repeat(40 * 1024) + '}'
      const res = await chunkedPost(server, path, payload)
      expect(res.status).toBe(413)
    })
  }
  it('chunked small body still parses on public route', async () => {
    const res = await chunkedPost(server, '/api/schedule/volunteer-roster', JSON.stringify({ assignments: [{ role: 'av_tech' }] }))
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).total_volunteers_assigned).toBe(1)
  })
})
