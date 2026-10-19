// Browser policy headers — CSP Report-Only + Permissions-Policy baseline.
//
// OC-READY-01-014. These strings are the intended future Enforce policy.
// This module MUST NOT export or apply a Content-Security-Policy Enforce
// header. Report-Only is the only CSP mode this tree ships.
//
// Kept as plain strings (no helmet) so the same values can be locked into
// vercel.json for the static HTML shell. server/tests/browserPolicies.test.js
// fails if the two copies drift, or if Enforce appears on either surface.

export const CONTENT_SECURITY_POLICY_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://bible-api.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
].join('; ')

// no-referrer, including same-origin. strict-origin-when-cross-origin is the
// browser default and still sends the full URL on a same-origin POST, so
// /accept-invite?token= and /reset?token= would ride along as Referer.
export const REFERRER_POLICY = 'no-referrer'

// Conservative feature policy: no camera, mic, location, Payment Request,
// USB, or Topics. Clipboard is intentionally omitted — Bulletin and
// public-link copy use navigator.clipboard.writeText.
export const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'display-capture=()',
  'browsing-topics=()',
].join(', ')
