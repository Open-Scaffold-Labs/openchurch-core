// Unsubscribe tokens — the credential in a List-Unsubscribe URL.
//
// Why not a JWT: the link has to work when someone digs up a reminder
// from eleven months ago, which is precisely when people unsubscribe.
// An expiring token turns "stop emailing me" into "that link is no
// longer valid", and a mail client that gets a failure from a one-click
// unsubscribe reports the sender, not the link. So: no expiry.
//
// What stops abuse is that the token is an HMAC over a specific
// (user, notification_type) pair. Guessing another user's token means
// forging the MAC. A token that IS leaked can only do one thing — turn
// off one notification type for one person — which is a nuisance, not a
// breach, and the person can turn it straight back on in the app.
//
// The key is derived from JWT_SECRET with a domain separator rather than
// being its own env var, following src/ai/orgProvider.js. A separate
// required secret would mean production stops sending mail until someone
// sets it; derivation means this ships working. The separator is what
// keeps an unsubscribe token from ever being valid as anything else.

import crypto from 'node:crypto'

function key() {
  const secret = process.env.JWT_SECRET || 'dev-only-change-me-please'
  return crypto.createHash('sha256').update(`${secret}:ochr-unsubscribe-v1`).digest()
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

// The signed part. Kept as a single string so the MAC covers the
// delimiter too — otherwise ('12', '3.x') and ('123', 'x') would share a
// payload and therefore a signature.
function payload(userId, notificationType) {
  return `${userId}:${notificationType}`
}

export function signUnsubscribe(userId, notificationType) {
  const body = payload(userId, notificationType)
  const mac  = crypto.createHmac('sha256', key()).update(body).digest()
  return `${b64url(body)}.${b64url(mac)}`
}

// Returns { userId, notificationType } or null. Never throws — every
// malformed shape a stranger can put in a URL lands on the same null.
export function verifyUnsubscribe(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null

  const [bodyPart, macPart] = token.split('.')
  if (!bodyPart || !macPart) return null

  let body, given
  try {
    body  = Buffer.from(bodyPart, 'base64url').toString('utf8')
    given = Buffer.from(macPart, 'base64url')
  } catch {
    return null
  }

  const expected = crypto.createHmac('sha256', key()).update(body).digest()

  // timingSafeEqual throws on a length mismatch, so check length first.
  // A wrong length is already a wrong MAC; there is nothing to leak.
  if (given.length !== expected.length) return null
  if (!crypto.timingSafeEqual(given, expected)) return null

  // Only split after the MAC verifies — parsing unauthenticated input is
  // how a verified-looking value ends up in a query.
  const sep = body.indexOf(':')
  if (sep <= 0) return null

  const userId = Number(body.slice(0, sep))
  const notificationType = body.slice(sep + 1)
  if (!Number.isSafeInteger(userId) || userId <= 0) return null
  if (!notificationType) return null

  return { userId, notificationType }
}
