// Argus R427 follow-ups that are not the route-tree guard itself:
//   - requireCronAuth compares the bearer in constant time (timingSafeEqual)
//     and still answers 503 / 401 / next() exactly as before.
//   - the new limiters on unauthenticated surfaces actually trip.
// No database: every request here is refused before a query runs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import crypto from 'node:crypto'
import { requireCronAuth } from '../src/middleware/cronAuth.js'
import {
  resetPasswordLimiter, acceptInviteLimiter, kioskTokenLimiter,
  calendarFeedLimiter, publicScheduleLimiter,
} from '../src/middleware/rateLimit.js'

function cronApp() {
  const app = express()
  app.get('/c', requireCronAuth, (_req, res) => res.json({ ok: true }))
  return app
}

describe('requireCronAuth (R427 constant-time compare)', () => {
  const saved = process.env.CRON_SECRET
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = saved
    vi.restoreAllMocks()
  })

  it('503 when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET
    expect((await request(cronApp()).get('/c')).status).toBe(503)
  })

  it('401 for missing, wrong, shorter, longer and prefix bearers; 200 for the exact one', async () => {
    process.env.CRON_SECRET = 's3cret-value'
    const app = cronApp()
    expect((await request(app).get('/c')).status).toBe(401)
    for (const h of ['Bearer wrong', 'Bearer s', 'Bearer s3cret-value-and-more', 'Bearer s3cret-valu', 's3cret-value', 'bearer s3cret-value']) {
      expect((await request(app).get('/c').set('Authorization', h)).status).toBe(401)
    }
    expect((await request(app).get('/c').set('Authorization', 'Bearer s3cret-value')).status).toBe(200)
  })

  it('goes through crypto.timingSafeEqual (not ===)', async () => {
    process.env.CRON_SECRET = 'abc'
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    await request(cronApp()).get('/c').set('Authorization', 'Bearer nope-different-length')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

function limitedApp(limiter, status) {
  const app = express()
  app.set('trust proxy', 1)
  app.post('/x', limiter, (_req, res) => res.status(status).json({}))
  app.get('/x', limiter, (_req, res) => res.status(status).json({}))
  return app
}

async function hitsUntil429(app, method, max) {
  for (let i = 1; i <= max; i++) {
    const res = await request(app)[method]('/x').set('X-Forwarded-For', '203.0.113.7').send({})
    if (res.status === 429) return i
  }
  return null
}

describe('R427 limiters on unauthenticated surfaces', () => {
  beforeEach(async () => {
    for (const l of [resetPasswordLimiter, acceptInviteLimiter, kioskTokenLimiter, calendarFeedLimiter, publicScheduleLimiter]) {
      await l.resetKey('203.0.113.7')
    }
  })

  it('reset-password: 20 failed attempts per IP, then 429', async () => {
    expect(await hitsUntil429(limitedApp(resetPasswordLimiter, 400), 'post', 30)).toBe(21)
  })

  it('accept-invite: 20 failed attempts per IP, then 429', async () => {
    expect(await hitsUntil429(limitedApp(acceptInviteLimiter, 400), 'post', 30)).toBe(21)
  })

  it('reset-password: successful requests never count', async () => {
    expect(await hitsUntil429(limitedApp(resetPasswordLimiter, 200), 'post', 40)).toBe(null)
  })

  it('kiosk GET /:token: 60 misses per IP, then 429; hits never count', async () => {
    expect(await hitsUntil429(limitedApp(kioskTokenLimiter, 200), 'get', 80)).toBe(null)
    expect(await hitsUntil429(limitedApp(kioskTokenLimiter, 404), 'get', 80)).toBe(61)
  })

  it('calendar ICS feed: misses only, loose ceiling (300)', async () => {
    expect(await hitsUntil429(limitedApp(calendarFeedLimiter, 200), 'get', 50)).toBe(null)
    expect(await hitsUntil429(limitedApp(calendarFeedLimiter, 404), 'get', 310)).toBe(301)
  })

  it('public schedule POSTs: every request counts, 60 per IP', async () => {
    expect(await hitsUntil429(limitedApp(publicScheduleLimiter, 200), 'post', 70)).toBe(61)
  })
})
