// CAP_SERVER_URL is the parish address Dale points the iOS shell at.
// It is read when `cap sync` runs. It is not a secret and it has no
// default. An empty value means the shell loads the bundled page.

const REFUSED = {
  empty: null,
  userinfo: 'CAP_SERVER_URL must not include a username or password',
  protocol: 'CAP_SERVER_URL must use http or https',
  shape: 'CAP_SERVER_URL must be a single absolute http(s) address',
  query: 'CAP_SERVER_URL must not include a query or fragment',
}

export function resolveCapServer(raw) {
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return null
  if (/\s/.test(text)) {
    const error = new Error(REFUSED.shape)
    error.code = 'cap_server_url_shape'
    throw error
  }
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    const error = new Error(REFUSED.shape)
    error.code = 'cap_server_url_shape'
    throw error
  }
  if (parsed.username || parsed.password) {
    const error = new Error(REFUSED.userinfo)
    error.code = 'cap_server_url_userinfo'
    throw error
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const error = new Error(REFUSED.protocol)
    error.code = 'cap_server_url_protocol'
    throw error
  }
  if (parsed.search || parsed.hash) {
    const error = new Error(REFUSED.query)
    error.code = 'cap_server_url_query'
    throw error
  }
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
  return {
    url: parsed.origin + path,
    cleartext: parsed.protocol === 'http:',
    allowNavigation: [parsed.hostname],
  }
}

// The iOS build must keep /api on the page's own origin. A baked-in
// VITE_API_URL would make the session cookie cross-site, and
// SameSite=Lax would not send it.
export function assertIosBuildEnv(env = process.env) {
  const api = env.VITE_API_URL
  if (typeof api === 'string' && api.trim()) {
    const error = new Error(
      'ios sync refuses VITE_API_URL. The shell keeps the parish sign-in only when /api is the same address as the page.',
    )
    error.code = 'ios_api_url_refused'
    throw error
  }
  const push = env.VITE_ENABLE_IOS_PUSH
  if (push != null && String(push).trim() && String(push).trim() !== '1') {
    const error = new Error('VITE_ENABLE_IOS_PUSH must be unset or exactly 1')
    error.code = 'ios_push_flag'
    throw error
  }
  // CAP_RELEASE=1 marks a build headed for TestFlight or the App Store.
  // A release shell must reach the parish over https: a cleartext address
  // would carry the session cookie unencrypted and needs an ATS exception.
  const releaseRaw = env.CAP_RELEASE
  if (releaseRaw != null && String(releaseRaw).trim() && String(releaseRaw).trim() !== '1') {
    const error = new Error('CAP_RELEASE must be unset or exactly 1')
    error.code = 'cap_release_flag'
    throw error
  }
  const release = String(releaseRaw).trim() === '1'
  const server = resolveCapServer(env.CAP_SERVER_URL)
  if (release && server?.cleartext) {
    const error = new Error('CAP_SERVER_URL in release builds must use https')
    error.code = 'cap_server_url_release_http'
    throw error
  }
  return {
    capacitor: '1',
    push: String(push).trim() === '1',
    release,
    server,
  }
}
