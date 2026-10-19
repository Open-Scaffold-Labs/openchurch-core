// Production Sentry init, exercised as its own process.
// The suite loads monitoring with NODE_ENV=test, so the production branch
// never runs there. This file sets NODE_ENV and a localhost DSN before
// importing monitoring, then records whatever the SDK posts.
// It prints one PROBE_RESULT line of booleans. No DSN, token, or cookie.

import http from 'node:http'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

const bodies = []

const ingest = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const buf = Buffer.concat(chunks)
    let text = ''
    try {
      text = req.headers['content-encoding'] === 'gzip'
        ? zlib.gunzipSync(buf).toString('utf8')
        : buf.toString('utf8')
    } catch {
      text = buf.toString('utf8')
    }
    bodies.push(text)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})

await new Promise((resolve) => ingest.listen(0, '127.0.0.1', resolve))
const ingestPort = ingest.address().port

process.env.NODE_ENV = 'production'
process.env.SENTRY_DSN = `http://public@127.0.0.1:${ingestPort}/1`

const { monitor } = await import('../../src/monitoring/index.js')
const Sentry = await import('@sentry/node')

const deadline = Date.now() + 8000
while (!Sentry.getClient() && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25))
}

function report(result) {
  process.stdout.write(`PROBE_RESULT ${JSON.stringify(result)}\n`)
}

if (!Sentry.getClient()) {
  report({ enabled: false })
  process.exit(1)
}

const express = (await import('express')).default
const app = express()
const fail = (scope) => (_req, res) => {
  monitor.error(scope, new Error(`${scope} failed`))
  res.status(500).end()
}
app.get('/api/kiosk/:token', fail('probe.kiosk'))
app.get('/api/swap/by-token/:token', fail('probe.swap'))
app.get('/api/calendar-sync/:token.ics', fail('probe.calendar'))
app.post('/api/unsubscribe/:token', fail('probe.unsubscribe'))

const server = app.listen(0, '127.0.0.1')
await new Promise((resolve, reject) => {
  server.once('listening', resolve)
  server.once('error', reject)
})
const appPort = server.address().port

const kiosk = crypto.randomBytes(18).toString('base64url')
const swap = crypto.randomBytes(18).toString('base64url')
const cal = crypto.randomBytes(18).toString('base64url')
const unsub = `${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
const invite = crypto.randomBytes(18).toString('base64url')
const query = `q${crypto.randomBytes(6).toString('hex')}`
const cookie = crypto.randomBytes(18).toString('base64url')
const apiKey = crypto.randomBytes(12).toString('hex')
const city = `city${crypto.randomBytes(4).toString('hex')}`

async function hit(method, path) {
  await fetch(`http://127.0.0.1:${appPort}${path}`, {
    method,
    headers: {
      cookie: `ochr_session=${cookie}`,
      referer: `http://127.0.0.1/accept-invite?token=${invite}`,
      authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'x-vercel-ip-city': city,
      'x-forwarded-for': '203.0.113.44',
      accept: 'application/json',
    },
  })
}

await hit('GET', `/api/kiosk/${kiosk}?q=${query}`)
await hit('GET', `/api/swap/by-token/${swap}?q=${query}`)
await hit('GET', `/api/calendar-sync/${cal}.ics?q=${query}`)
await hit('POST', `/api/unsubscribe/${unsub}?q=${query}`)

await Sentry.flush(2000)

const blob = bodies.join('\n')
const absent = (value) => value.length > 0 && !blob.includes(value)
report({
  enabled: true,
  sawKiosk: blob.includes('probe.kiosk failed'),
  sawSwap: blob.includes('probe.swap failed'),
  sawCalendar: blob.includes('probe.calendar failed'),
  sawUnsubscribe: blob.includes('probe.unsubscribe failed'),
  kioskAbsent: absent(kiosk),
  swapAbsent: absent(swap),
  calAbsent: absent(cal),
  unsubAbsent: absent(unsub),
  inviteAbsent: absent(invite),
  queryAbsent: absent(query),
  cookieAbsent: absent(cookie),
  apiKeyAbsent: absent(apiKey),
  cityAbsent: absent(city),
  kioskPattern: blob.includes('/api/kiosk/:token'),
  swapPattern: blob.includes('/api/swap/by-token/:token'),
  calPattern: blob.includes('/api/calendar-sync/:token.ics'),
  unsubPattern: blob.includes('/api/unsubscribe/:token'),
})

server.close()
ingest.close()
process.exit(0)
