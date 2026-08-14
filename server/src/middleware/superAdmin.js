// requireSuperAdmin — gates the founder-only workbench surfaces.
//
// There is deliberately NO super-admin role in the database: roles are
// tenant concepts (admin/staff/viewer within an org), and inventing a
// cross-tenant role row would be a standing privilege-escalation
// target. Instead the system operator is identified by env config:
// the verified JWT email claim must equal SUPER_ADMIN_EMAIL.
//
// Fails closed twice over: no env var configured → 404; wrong email →
// 404. A 404 (not 403) so the surface's existence isn't advertised to
// curious authenticated users probing /api/admin/*.
//
// Mount AFTER requireAuth — this middleware trusts req.user.email only
// because requireAuth already verified the JWT signature.

export function requireSuperAdmin(req, res, next) {
  const configured = process.env.SUPER_ADMIN_EMAIL
  if (!configured) return res.status(404).json({ error: 'Not found' })

  const email = req.user?.email
  if (!email || email.toLowerCase() !== configured.trim().toLowerCase()) {
    return res.status(404).json({ error: 'Not found' })
  }

  next()
}

// isVendorAdmin — the Support Console's cross-tenant read identity
// (SUP.1). Same philosophy as requireSuperAdmin (env-identified, no
// cross-tenant DB role, fail-closed: nothing configured → nobody is
// vendor), extended for a team: VENDOR_ADMIN_EMAILS is a comma-
// separated allowlist, and the SUPER_ADMIN_EMAIL founder is always a
// vendor so one env var keeps working until there's a second triager.
//
// A boolean helper rather than middleware because the support routes
// blend scopes in one handler (parish admin sees own org; vendor sees
// all) — there is no clean mount-level split to gate.
//
// Call AFTER requireAuth only — trusts req.user.email because
// requireAuth already verified the JWT signature.
export function isVendorAdmin(req) {
  const list = (process.env.VENDOR_ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const founder = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase()
  if (founder) list.push(founder)
  if (!list.length) return false // fail-closed
  const email = (req.user?.email || '').toLowerCase()
  return !!email && list.includes(email)
}
