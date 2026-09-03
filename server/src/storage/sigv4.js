// AWS Signature Version 4, by hand.
//
// WHY NOT THE SDK. @aws-sdk/client-s3 is tens of megabytes and drags a
// vendor's whole client surface into a project whose stated convention is
// vendor-neutral plumbing. SigV4 is a documented, stable algorithm —
// four hashes and an HMAC chain — and writing it here means the storage
// seam works against S3, Cloudflare R2, Backblaze B2, Supabase Storage,
// MinIO or anything else that speaks the protocol, with no dependency and
// no vendor in the import list.
//
// WHY THIS IS SAFE TO HAND-ROLL. Because it is falsifiable. Amazon
// publishes worked examples with the exact expected canonical request,
// string-to-sign and signature for a given input. The suite drives this
// function against those vectors, so "I think the signing is right" is
// never the standard — a wrong byte anywhere in the chain changes the
// final hex and the test fails.
//
// Scope is deliberately small: the four operations the backup needs
// (PUT, GET, HEAD, and a prefix LIST), single-chunk, payload hashed up
// front. No streaming, no multipart, no presigning.

import { createHash, createHmac } from 'node:crypto'

const sha256hex = b => createHash('sha256').update(b).digest('hex')
const hmac = (key, str) => createHmac('sha256', key).update(str, 'utf8').digest()

// RFC 3986, which is stricter than encodeURIComponent: the four
// characters below are "unreserved" and must NOT be escaped, and
// everything else must be. Getting this wrong produces a signature that
// verifies locally and is rejected by the service, which is the most
// confusing possible failure.
export function uriEncode(str, encodeSlash = true) {
  let out = ''
  for (const ch of String(str)) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) { out += ch; continue }
    if (ch === '/' && !encodeSlash) { out += ch; continue }
    for (const byte of Buffer.from(ch, 'utf8')) {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
    }
  }
  return out
}

// Query strings are signed sorted by key, then by value, with both
// encoded. A different order is a different signature.
function canonicalQuery(query = {}) {
  return Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [uriEncode(k), uriEncode(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

// Header names lowercased, values trimmed and inner whitespace
// collapsed, sorted by name.
function canonicalHeaders(headers) {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return {
    canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: entries.map(([k]) => k).join(';'),
  }
}

// Exported so the tests can check the intermediate strings, not only the
// final hex. When a signature is wrong, knowing WHICH of the four steps
// diverged is the difference between a fix and an afternoon.
export function canonicalRequest({ method, path, query, headers, payloadHash }) {
  const { canonical, signed } = canonicalHeaders(headers)
  return {
    text: [
      method,
      uriEncode(path, false) || '/',
      canonicalQuery(query),
      canonical,
      signed,
      payloadHash,
    ].join('\n'),
    signedHeaders: signed,
  }
}

export function stringToSign({ amzDate, scope, canonicalRequestText }) {
  return ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequestText)].join('\n')
}

export function signingKey({ secretKey, dateStamp, region, service }) {
  return hmac(hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service), 'aws4_request')
}

// 20130524T000000Z / 20130524 — the two forms both appear in the
// signature and must agree.
export function amzDates(date) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

// The whole thing: returns the headers to send.
export function signRequest({
  method, host, path, query = {}, headers = {}, payload = Buffer.alloc(0),
  accessKeyId, secretAccessKey, sessionToken = null,
  region, service = 's3', date = new Date(),
}) {
  const { amzDate, dateStamp } = amzDates(date)
  const payloadHash = sha256hex(payload)

  const all = {
    ...headers,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
  }

  const { text, signedHeaders } = canonicalRequest({ method, path, query, headers: all, payloadHash })
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const sts = stringToSign({ amzDate, scope, canonicalRequestText: text })
  const signature = hmac(signingKey({ secretKey: secretAccessKey, dateStamp, region, service }), sts).toString('hex')

  return {
    ...all,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    _debug: { canonicalRequest: text, stringToSign: sts, signature },
  }
}
