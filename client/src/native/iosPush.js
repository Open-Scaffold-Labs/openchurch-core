// iOS notice permission. This build asks the device and then stops.
// The device token is not stored, logged, or sent. There is no
// provider key on this path.

const RECEIVE = new Set(['granted', 'denied', 'prompt', 'prompt-with-rationale'])

function tokenArrived(token) {
  return Boolean(token && typeof token.value === 'string' && token.value.length > 0)
}

function finishOnce(finish, timer, value) {
  clearTimeout(timer)
  finish(value)
}

async function registerWithoutSending(plugin) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), 8000)
    Promise.resolve()
      .then(() => plugin.addListener('registration', (token) => {
        finishOnce(finish, timer, tokenArrived(token))
      }))
      .then(() => plugin.addListener('registrationError', () => {
        finishOnce(finish, timer, false)
      }))
      .then(() => plugin.register())
      .catch(() => finishOnce(finish, timer, false))
  })
}

export async function requestNativeNoticePermission(plugin) {
  if (
    !plugin
    || typeof plugin.checkPermissions !== 'function'
    || typeof plugin.requestPermissions !== 'function'
    || typeof plugin.register !== 'function'
    || typeof plugin.addListener !== 'function'
  ) {
    return { state: 'unavailable' }
  }

  let current
  try {
    current = await plugin.checkPermissions()
  } catch {
    return { state: 'unavailable' }
  }
  const receive = current?.receive
  if (!RECEIVE.has(receive)) return { state: 'unavailable' }
  if (receive === 'denied') return { state: 'denied' }

  let next = current
  if (receive !== 'granted') {
    try {
      next = await plugin.requestPermissions()
    } catch {
      return { state: 'unavailable' }
    }
  }
  if (next?.receive === 'denied') return { state: 'denied' }
  if (next?.receive !== 'granted') return { state: 'declined' }

  let registered = false
  try {
    registered = await registerWithoutSending(plugin)
  } catch {
    registered = false
  }
  return registered ? { state: 'granted' } : { state: 'not-registered' }
}
