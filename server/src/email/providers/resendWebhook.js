// Resend webhook adapter. The ONLY file that knows Resend's payload shape
// or Svix's signing scheme — everything downstream speaks the neutral
// { kind, email, providerMessageId, providerEventId, detail } shape below.
// Swapping to Postmark or SES means writing a sibling of this file.
//
// Signature scheme (Svix, which Resend uses):
//   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
//   secret         = base64 decode of everything after "whsec_"
//   svix-signature = space-separated list of "v1,<base64 hmac-sha256>"
// Any one entry matching is a pass; the list exists so a secret can be
// rotated without dropping deliveries mid-rotation.
//
// Verification is done here rather than in the route because it needs the
// RAW bytes. Parsing and re-serialising JSON changes key order and
// whitespace, and the signature is over the bytes — this is why the route
// mounts before express.json().

import crypto from 'node:crypto'

// How far out of date a webhook may be. Svix's own default. Without it a
// captured request can be replayed forever: the signature stays valid
// because the body never changes.
const TOLERANCE_SECONDS = 5 * 60

export class WebhookError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

function secretKey() {
  const raw = process.env.RESEND_WEBHOOK_SECRET
  if (!raw) return null
  const b64 = raw.startsWith('whsec_') ? raw.slice('whsec_'.length) : raw
  try {
    return Buffer.from(b64, 'base64')
  } catch {
    return null
  }
}

export function webhookConfigured() {
  return secretKey() !== null
}

// Throws WebhookError on anything that is not a provably authentic,
// in-date request. There is no "probably fine" branch: an unverified
// webhook can suppress any address it names, so failing closed here is
// the difference between a delivery signal and an open endpoint that lets
// a stranger stop a parish's email.
export function verifySignature({ rawBody, headers }) {
  const key = secretKey()
  if (!key) {
    throw new WebhookError('RESEND_WEBHOOK_SECRET is not configured', 503)
  }

  const id        = headers['svix-id']
  const timestamp = headers['svix-timestamp']
  const signature = headers['svix-signature']
  if (!id || !timestamp || !signature) {
    throw new WebhookError('Missing Svix signature headers')
  }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) throw new WebhookError('Malformed svix-timestamp')
  const age = Math.abs(Math.floor(Date.now() / 1000) - ts)
  if (age > TOLERANCE_SECONDS) throw new WebhookError('Webhook timestamp outside tolerance')

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '')
  const expected = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest()

  const offered = String(signature).split(' ')
    .map(part => part.includes(',') ? part.slice(part.indexOf(',') + 1) : part)
    .map(b64 => { try { return Buffer.from(b64, 'base64') } catch { return null } })
    .filter(Boolean)

  const ok = offered.some(sig =>
    sig.length === expected.length && crypto.timingSafeEqual(sig, expected)
  )
  if (!ok) throw new WebhookError('Signature mismatch')

  try {
    return JSON.parse(body)
  } catch {
    throw new WebhookError('Body is not valid JSON')
  }
}

// Translate one verified Resend event into the neutral shape.
//
// `kind` is one of:
//   'hard_bounce'  — permanent; suppress the address
//   'complaint'    — the recipient marked it as spam; suppress
//   'soft_bounce'  — temporary; record the delivery failure, do NOT suppress
//   'delivered'    — correct the log row upward
//   'ignored'      — opens, clicks, sends; nothing to record
//
// Soft bounces stay unsuppressed deliberately. A full mailbox recovers,
// and treating it as permanent silently deletes a real recipient — a
// failure nobody notices, because the symptom is mail that stops arriving
// for someone who never asked it to. Suppressing too little costs domain
// reputation; suppressing too much costs the person. Only explicitly
// permanent bounces suppress, and anything ambiguous is treated as soft.
export function interpret(event) {
  const type = event?.type
  const data = event?.data ?? {}
  const email = Array.isArray(data.to) ? data.to[0] : (data.to ?? data.email ?? null)
  const base = {
    email,
    providerMessageId: data.email_id ?? data.id ?? null,
    providerEventId:   event?.id ?? null,
    detail:            null,
  }

  switch (type) {
    case 'email.bounced': {
      const bounceType = String(data.bounce?.type ?? '').toLowerCase()
      const hard = bounceType === 'permanent' || bounceType === 'hard'
      return {
        ...base,
        kind: hard ? 'hard_bounce' : 'soft_bounce',
        detail: data.bounce?.message ?? data.bounce?.subType ?? bounceType ?? null,
      }
    }
    case 'email.complained':
      return { ...base, kind: 'complaint', detail: 'recipient marked as spam' }
    case 'email.delivered':
      return { ...base, kind: 'delivered' }
    default:
      return { ...base, kind: 'ignored' }
  }
}
