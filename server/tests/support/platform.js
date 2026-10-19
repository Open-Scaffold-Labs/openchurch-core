// Test-only stand-in for the operator step F-01 now requires: look up the
// LIVE user id that holds `email` and list it in SUPER_ADMIN_USER_IDS (when
// the test configured that address as founder) and/or VENDOR_ADMIN_USER_IDS
// (when it is in VENDOR_ADMIN_EMAILS). The email itself grants nothing in
// the app (middleware/superAdmin.js); suites that still set the email vars
// use this to say "and the operator listed this person's id".
import pool from '../../src/db.js'

const norm = s => String(s || '').trim().toLowerCase()
const add = (key, id) => {
  const ids = new Set(String(process.env[key] || '').split(',').map(s => s.trim()).filter(Boolean))
  ids.add(String(id)); process.env[key] = [...ids].join(',')
}

export async function grantPlatformIdFor(email) {
  const { rows } = await pool.query(
    'SELECT id FROM ochr_users WHERE lower(btrim(email)) = $1 AND closed_at IS NULL AND deactivated_at IS NULL ORDER BY id',
    [norm(email)])
  if (rows.length !== 1) throw new Error(`grantPlatformIdFor: expected one live holder, got ${rows.length}`)
  const asFounder = norm(process.env.SUPER_ADMIN_EMAIL) === norm(email)
  const asVendor = String(process.env.VENDOR_ADMIN_EMAILS || '').split(',').map(norm).includes(norm(email))
  if (!asFounder && !asVendor) throw new Error('grantPlatformIdFor: address is not configured as founder or vendor')
  if (asFounder) add('SUPER_ADMIN_USER_IDS', rows[0].id)
  if (asVendor) add('VENDOR_ADMIN_USER_IDS', rows[0].id)
  return rows[0].id
}

export function clearPlatformIds() {
  delete process.env.SUPER_ADMIN_USER_IDS
  delete process.env.VENDOR_ADMIN_USER_IDS
}
