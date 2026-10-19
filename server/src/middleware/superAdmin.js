// Founder (super-admin) and vendor (Support Console) identity.
//
// There is still deliberately NO super-admin role in the tenant role
// column: roles are tenant concepts (admin/staff/viewer within an org).
// The operator is configured by env, but privilege is keyed on a USER ID,
// never on an email string alone (F-01 / ARGUS PART 0).
//
// Why: login closure (migration 112) releases an email for reuse and
// signup has no mailbox proof. Matching the token email to
// SUPER_ADMIN_EMAIL let anyone re-register a closed or never-held founder
// or vendor address and inherit the cross-tenant gates.
//
// A user is founder / vendor ONLY when their user id is listed in
// SUPER_ADMIN_USER_IDS / VENDOR_ADMIN_USER_IDS. There is no email path:
// SUPER_ADMIN_EMAIL / VENDOR_ADMIN_EMAILS grant nothing (they may still name
// a notification recipient elsewhere), there is no binding table, and nothing
// is granted automatically by a migration or a first login (TARS #62
// 6228025968: fail closed, no email fallback, no automatic grants). User ids
// are serial and never reused, so a closed login's address cannot carry the
// privilege to a new account.
//
// requireAuth has already confirmed the live row is not closed or
// deactivated before this runs, so a listed id that is closed/deactivated
// never reaches here. The result lands on req.user.platform.
//
// Fail closed: nothing configured -> nobody is founder or vendor. Founder
// 404s (not 403) so the surface is not advertised to authenticated users
// probing /api/admin/*.

// Strict list: canonical positive int4 ids only; anything else is ignored.
function idList(raw) {
  return String(raw || '').split(',').map(s => s.trim())
    .filter(s => /^[1-9][0-9]{0,9}$/.test(s)).map(Number).filter(n => n <= 2147483647)
}

// Called by requireAuth with the LIVE row id. Returns { founder, vendor }.
// `liveEmail` and `db` are accepted for call-site compatibility and unused.
export async function resolvePlatformIdentity(userId) {
  const out = { founder: false, vendor: false }
  if (!Number.isInteger(userId) || userId <= 0) return out
  if (idList(process.env.SUPER_ADMIN_USER_IDS).includes(userId)) out.founder = true
  if (idList(process.env.VENDOR_ADMIN_USER_IDS).includes(userId)) out.vendor = true
  if (out.founder) out.vendor = true // the founder is always a vendor
  return out
}

export function requireSuperAdmin(req, res, next) {
  if (req.user?.platform?.founder !== true) {
    return res.status(404).json({ error: 'Not found' })
  }
  next()
}

// Boolean helper (support routes blend scopes in one handler). Call AFTER
// requireAuth only.
export function isVendorAdmin(req) {
  return req.user?.platform?.vendor === true
}
