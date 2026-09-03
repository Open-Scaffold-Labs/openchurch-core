import request from 'supertest'

// createOrg — the one place the suite creates an organization.
//
// Public signup creates parishes and refuses everything else, because a
// stranger being able to stamp a diocese and start inviting parishes was a
// real hole (see routes/auth.js). A diocese now enters through the
// operator's door: requireSuperAdmin, identified by SUPER_ADMIN_EMAIL,
// mounted on /api/admin/maintenance.
//
// The tests go through that door rather than around it. Two reasons: a test
// that reached past the guard would keep passing if the guard were deleted,
// and routing every diocese in the suite through the provisioning route
// means that route is exercised by ~21 call sites instead of the one test
// written for it.
//
// Returns the same shape POST /api/auth/signup does — { status, body:
// { token, user } } — so callers do not care which door was used.

// One operator per test FILE (each vitest file is its own module instance),
// so the suite does not create an operator org per diocese.
let operator = null
let ipSeq = 0

async function ensureOperator(server) {
  if (operator) return operator
  const email = `provision_operator_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}@openchurch.test`
  const password = 'provision-operator-pw-1'
  const res = await request(server).post('/api/auth/signup')
    .set('X-Forwarded-For', `10.250.0.${(ipSeq++ % 250) + 1}`)
    .send({ organizationName: `Provisioning Operator ${email}`, name: 'Operator', email, password })
  if (res.status !== 201) {
    throw new Error(`provision: could not create the operator account (${res.status}): ${JSON.stringify(res.body)}`)
  }
  operator = { email, token: res.body.token, orgId: res.body.user.organization.id }
  return operator
}

export async function createOrg(server, payload, ip = '10.251.0.1') {
  const type = payload.organizationType ?? 'parish'
  if (type === 'parish') {
    return request(server).post('/api/auth/signup').set('X-Forwarded-For', ip).send(payload)
  }

  const op = await ensureOperator(server)
  const previous = process.env.SUPER_ADMIN_EMAIL
  process.env.SUPER_ADMIN_EMAIL = op.email
  let made
  try {
    made = await request(server).post('/api/admin/maintenance/organizations')
      .set('Authorization', `Bearer ${op.token}`)
      .send(payload)
  } finally {
    // Restored, not cleared: smoke.test.js sets this var around its own
    // super-admin tests and must not find it changed underneath them.
    if (previous === undefined) delete process.env.SUPER_ADMIN_EMAIL
    else process.env.SUPER_ADMIN_EMAIL = previous
  }
  if (made.status !== 201) return made

  // Provisioning deliberately returns no token — the operator does not hold
  // a session for a customer's chancery. The tests need one, so they sign
  // in as that chancery's own admin, exactly as its first user would.
  const login = await request(server).post('/api/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email: payload.email, password: payload.password })
  if (login.status !== 200) {
    throw new Error(`provision: provisioned ${payload.email} but could not sign in (${login.status})`)
  }
  return { status: 201, body: login.body }
}

// The operator's own org, for suites that assert on how many organizations
// exist or clean up after themselves.
export const provisioningOperatorOrgId = () => operator?.orgId ?? null
