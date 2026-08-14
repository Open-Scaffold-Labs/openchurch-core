// Minimal Stripe REST client + webhook signature check. Used by the two
// provider files (billing/provider.js, payments/index.js) — nothing else
// should import this. Plain fetch + form-encoding, no SDK: keeps the
// serverless bundle lean and the vendor surface in one place.

import crypto from 'node:crypto'

// Stripe's API takes application/x-www-form-urlencoded with bracket
// notation for nesting: line_items[0][price_data][unit_amount]=7900
function encodeForm(params, prefix = '', out = []) {
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null) continue
    const name = prefix ? `${prefix}[${key}]` : key
    if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (typeof v === 'object' && v !== null) encodeForm(v, `${name}[${i}]`, out)
        else out.push(`${name}[${i}]=${encodeURIComponent(v)}`)
      })
    } else if (typeof val === 'object') {
      encodeForm(val, name, out)
    } else {
      out.push(`${name}=${encodeURIComponent(val)}`)
    }
  }
  return out
}

// POST (or GET with null params) to https://api.stripe.com/v1/<path>.
// Throws on non-2xx with Stripe's error message so callers can log it;
// returns the parsed JSON body on success.
export async function stripeRequest(path, params, secretKey, { method } = {}) {
  if (!secretKey) throw new Error('stripeRequest: missing secret key')
  const m = method ?? (params ? 'POST' : 'GET')
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: m,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      ...(m === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(m === 'POST' && params ? { body: encodeForm(params).join('&') } : {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`
    throw new Error(`Stripe ${path} failed: ${msg}`)
  }
  return data
}

// Verify a Stripe webhook signature header:
//   Stripe-Signature: t=<unix>,v1=<hmac>,v1=<older-hmac-during-rotation>
// HMAC-SHA256 over `${t}.${rawBody}` with the webhook signing secret.
// Constant-time compare; 5-minute replay tolerance. Returns true/false —
// the caller decides how to fail (our webhook route 400s, fail closed).
export function verifyStripeSignature(rawBody, header, signingSecret, toleranceSec = 300) {
  if (!header || !signingSecret) return false
  const parts = Object.create(null)
  for (const kv of String(header).split(',')) {
    const [k, v] = kv.split('=', 2)
    if (!k || !v) continue
    if (k.trim() === 'v1') (parts.v1 ??= []).push(v.trim())
    else parts[k.trim()] = v.trim()
  }
  const t = Number(parts.t)
  if (!Number.isFinite(t) || !parts.v1?.length) return false
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false

  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')
  const expected = crypto
    .createHmac('sha256', signingSecret)
    .update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), payload]))
    .digest('hex')
  const expectedBuf = Buffer.from(expected, 'utf8')

  return parts.v1.some((candidate) => {
    const candBuf = Buffer.from(candidate, 'utf8')
    return candBuf.length === expectedBuf.length && crypto.timingSafeEqual(candBuf, expectedBuf)
  })
}
