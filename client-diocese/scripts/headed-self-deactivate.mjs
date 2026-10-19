// Headed measurement for chancery self-deactivation.
//
// Serves the real client-diocese dev app. main.jsx installs the session
// wrapper around the browser's own fetch. This script never assigns
// window.fetch. API answers are a synthetic transport (CDP Fetch fulfill /
// fail) on the local page origin only. No production host, no parish login.
//
//   node client-diocese/scripts/headed-self-deactivate.mjs --out <dir>

import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STRINGS } from '../src/i18n/strings.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..')
const REPO = join(CLIENT, '..')
const APP_ORIGIN = 'http://127.0.0.1:5204'
const ACCOUNT_URL = `${APP_ORIGIN}/account`
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', 'fonts.googleapis.com', 'fonts.gstatic.com'])

const USER = {
  id: 4,
  name: 'Canon Example',
  organization: { name: 'Demonstration Diocese', is_demo: true },
}
const SERVER_401 = 'Invalid or expired token'
const SERVER_500 = 'Failed to deactivate this login'
const SERVER_LAST_ADMIN = 'Cannot deactivate the only active admin. Transfer administration first. Closing the organization is a separate step and is not done here.'

const outDir = argValue('--out') || join(tmpdir(), 'headed-self-deactivate')
const requiredSha = process.env.REQUIRED_SHA || ''

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : ''
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()
}

function capturedAt(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).formatToParts(date)
  const get = type => parts.find(part => part.type === type)?.value
  const offset = get('timeZoneName') || ''
  const match = offset.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
  let zone = '-07:00'
  if (match) {
    const hours = match[2].padStart(2, '0')
    const minutes = (match[3] || '00').padStart(2, '0')
    zone = `${match[1]}${hours}:${minutes}`
  }
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${zone}`
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.next = 0
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message || 'cdp error'}: ${JSON.stringify(msg.error)}`))
        else resolve(msg.result || {})
      } else if (msg.method) {
        for (const listener of this.listeners) listener(msg)
      }
    })
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('cdp socket closed'))
      this.pending.clear()
    })
  }

  send(method, params = {}) {
    const id = ++this.next
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(listener) {
    this.listeners.push(listener)
  }
}

function openSocket(url) {
  const ws = new WebSocket(url)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket timeout ${url}`)), 10000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`websocket error ${url}`))
    })
  })
}

function jsonResult(status, body) {
  return {
    status,
    contentType: 'application/json',
    raw: JSON.stringify(body),
  }
}

function transportResult(method, path, scenario) {
  if (method === 'GET' && path === '/api/auth/me') return jsonResult(200, { user: USER })
  if (method === 'GET' && path === '/api/diocese/parishes') return jsonResult(200, { parishes: [] })
  if (method === 'POST' && path === '/api/auth/logout') return jsonResult(200, { ok: true })
  if (method === 'GET' && path === '/api/session-probe') return jsonResult(401, { error: SERVER_401 })
  if (method === 'POST' && path === '/api/auth/deactivate') {
    if (scenario === 'lost') return { fail: 'ConnectionFailed' }
    if (scenario === '401') return jsonResult(401, { error: SERVER_401 })
    if (scenario === '500') return jsonResult(500, { error: SERVER_500 })
    if (scenario === '409') return jsonResult(409, { error: SERVER_LAST_ADMIN })
    if (scenario === 'nonjson') return { status: 200, contentType: 'text/plain', raw: 'not-json' }
    if (scenario === 'success') return jsonResult(200, { deactivated: true, already: false })
    return jsonResult(599, { error: 'deactivate was not expected' })
  }
  return jsonResult(404, { error: 'synthetic-unhandled', path, method })
}

function stackFrames(params) {
  const frames = []
  let stack = params?.initiator?.stack
  while (stack) {
    for (const frame of stack.callFrames || []) {
      frames.push({
        functionName: frame.functionName,
        url: frame.url,
        lineNumber: frame.lineNumber,
      })
    }
    stack = stack.parent
  }
  return frames
}

class PageSession {
  constructor(cdp, browser, targetId, locale, scenario) {
    this.cdp = cdp
    this.browser = browser
    this.targetId = targetId
    this.locale = locale
    this.scenario = scenario
    this.api = []
    this.hosts = []
    this.errors = []
    this.queue = []
    this.pumping = false
    this.sent = []
  }

  attach() {
    this.cdp.on(msg => {
      if (msg.method === 'Network.requestWillBeSent') {
        this.sent.push(msg.params)
        try {
          this.hosts.push(new URL(msg.params.request.url).host)
        } catch { /* ignore non-urls */ }
      }
      if (msg.method === 'Fetch.requestPaused') {
        this.queue.push(msg.params)
        this.pump()
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const text = msg.params?.exceptionDetails?.exception?.description
          || msg.params?.exceptionDetails?.text
          || 'exception'
        this.errors.push(text.split('\n')[0])
      }
    })
  }

  async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length) {
        const paused = this.queue.shift()
        try {
          await this.respond(paused)
        } catch (error) {
          this.errors.push(String(error))
          try {
            await this.cdp.send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'Failed' })
          } catch { /* the page will surface the failure */ }
        }
      }
    } catch (error) {
      this.errors.push(String(error))
    } finally {
      this.pumping = false
      if (this.queue.length) this.pump()
    }
  }

  async framesFor(paused) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const sent = this.sent.find(entry => entry.requestId === paused.networkId)
        || [...this.sent].reverse().find(entry => entry.request.url === paused.request.url && entry.request.method === paused.request.method)
      if (sent?.initiator) return stackFrames(sent)
      await sleep(30)
    }
    return []
  }

  async respond(paused) {
    const url = new URL(paused.request.url)
    const method = paused.request.method
    const path = url.pathname
    const frames = await this.framesFor(paused)
    const record = {
      method,
      path,
      url: paused.request.url,
      viaSessionFetch: frames.some(frame => frame.url.includes('/src/sessionFetch.js')),
      frames: frames.slice(0, 8),
    }
    this.api.push(record)
    const result = transportResult(method, path, this.scenario)
    record.status = result.fail ? 'network-fail' : result.status
    if (result.fail) {
      await this.cdp.send('Fetch.failRequest', {
        requestId: paused.requestId,
        errorReason: result.fail,
      })
      return
    }
    await this.cdp.send('Fetch.fulfillRequest', {
      requestId: paused.requestId,
      responseCode: result.status,
      responseHeaders: [{ name: 'Content-Type', value: result.contentType }],
      body: Buffer.from(result.raw).toString('base64'),
    })
  }

  async setup() {
    this.attach()
    await this.cdp.send('Page.enable')
    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Network.enable')
    await this.cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: `${APP_ORIGIN}/api/*`, requestStage: 'Request' }],
    })
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    })
    const localeLine = this.locale === 'es'
      ? "localStorage.setItem('ochr_locale', 'es');"
      : "localStorage.removeItem('ochr_locale');"
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('ochr_diocese_first_use_dismissed', '1'); ${localeLine} } catch (e) {}`,
    })
    await this.cdp.send('Page.navigate', { url: ACCOUNT_URL })
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    })
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text
      throw new Error(text || 'evaluate failed')
    }
    return result.result?.value
  }

  async waitFor(expression, timeout = 45000) {
    const start = Date.now()
    let last = null
    while (Date.now() - start < timeout) {
      last = await this.evaluate(expression)
      if (last?.ready) return last
      await sleep(100)
    }
    throw new Error(`timeout waiting for page: ${JSON.stringify(last)}`)
  }

  copy() {
    return STRINGS[this.locale]
  }

  async waitForAccount() {
    const title = this.copy()['account.deactivate.title']
    return this.waitFor(`(() => {
      const h2 = document.querySelector('h2')
      return {
        ready: h2?.textContent?.trim() === ${JSON.stringify(title)},
        h1: document.querySelector('h1')?.textContent?.trim() || '',
        h2: h2?.textContent?.trim() || '',
        body: document.body?.innerText?.slice(0, 800) || '',
      }
    })()`)
  }

  async wrapperProbe() {
    return this.evaluate(`(() => {
      const src = Function.prototype.toString.call(window.fetch)
      return {
        native: src.includes('[native code]'),
        mentionsDeactivate: src.includes('isSelfDeactivatePost'),
        mentionsCredentials: src.includes('credentials'),
        mentionsEvent: src.includes('UNAUTHORIZED_EVENT') || src.includes('opendiocese:unauthorized'),
        assignedByTest: src.includes('synthetic-unhandled') || src.includes('headed-self-deactivate'),
      }
    })()`)
  }

  async clickButton(name) {
    const point = await this.waitFor(`(() => {
      const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(name)} && !el.disabled)
      if (!button) return { ready: false, body: document.body?.innerText?.slice(0, 500) || '' }
      const rect = button.getBoundingClientRect()
      return { ready: rect.width > 0 && rect.height > 0, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`, 8000)
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, button: 'none',
    })
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    })
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    })
  }

  async snapshot() {
    const copy = this.copy()
    return this.evaluate(`(() => {
      const text = document.body?.innerText || ''
      const buttons = [...document.querySelectorAll('button')].map(el => el.textContent.trim())
      const dialog = document.querySelector('[role="alertdialog"]')
      const alert = document.querySelector('[role="alert"]')
      return {
        url: location.href,
        h1: document.querySelector('h1')?.textContent?.trim() || '',
        h2: document.querySelector('h2')?.textContent?.trim() || '',
        help: ${JSON.stringify(copy['account.deactivate.help'])},
        helpVisible: text.includes(${JSON.stringify(copy['account.deactivate.help'])}),
        dialogTitle: document.getElementById('confirm-title')?.textContent?.trim() || '',
        dialogBody: document.getElementById('confirm-body')?.textContent?.trim() || '',
        alert: alert?.textContent?.trim() || '',
        buttons,
        dialogOpen: Boolean(dialog),
        onLine: navigator.onLine,
      }
    })()`)
  }

  deactivateCalls() {
    return this.api.filter(call => call.method === 'POST' && call.path === '/api/auth/deactivate')
  }

  logoutCalls() {
    return this.api.filter(call => call.method === 'POST' && call.path === '/api/auth/logout')
  }

  async screenshot(filename) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' })
    const path = join(outDir, filename)
    await writeFile(path, Buffer.from(data, 'base64'))
    return path
  }

  async close() {
    try { await this.browser.send('Target.closeTarget', { targetId: this.targetId }) } catch { /* already gone */ }
    try { this.cdp.ws.close() } catch { /* already gone */ }
  }
}

async function waitHttp(url, timeout = 30000) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url)
      if (response.ok || response.status < 500) return
      last = String(response.status)
    } catch (error) {
      last = error.message
    }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${url}: ${last}`)
}

async function newPage(browserWsUrl, locale, scenario) {
  const browserWs = await openSocket(browserWsUrl)
  const browser = new Cdp(browserWs)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  let pageUrl = ''
  for (let i = 0; i < 50; i++) {
    const list = await fetch('http://127.0.0.1:9333/json/list').then(response => response.json())
    const page = list.find(entry => entry.id === targetId)
    if (page?.webSocketDebuggerUrl) {
      pageUrl = page.webSocketDebuggerUrl
      break
    }
    await sleep(100)
  }
  if (!pageUrl) throw new Error('page target has no debugger url')
  const pageWs = await openSocket(pageUrl)
  const session = new PageSession(new Cdp(pageWs), browser, targetId, locale, scenario)
  await session.setup()
  return session
}

function forbiddenHosts(hosts) {
  return [...new Set(hosts.filter(host => !ALLOWED_HOSTS.has(host.split(':')[0])))]
}

function wrapperOk(probe) {
  return probe
    && probe.native === false
    && probe.mentionsDeactivate === true
    && probe.mentionsCredentials === true
    && probe.mentionsEvent === true
    && probe.assignedByTest === false
}

function stayedSignedIn(snapshot, locale) {
  const copy = STRINGS[locale]
  return snapshot.buttons.includes(copy['auth.signOut'])
    && !snapshot.buttons.includes(copy['auth.signIn'])
    && snapshot.h1 === copy['account.title']
}

function signedOut(snapshot, locale) {
  const copy = STRINGS[locale]
  return snapshot.buttons.includes(copy['auth.signIn'])
    && !snapshot.buttons.includes(copy['auth.signOut'])
}

function noDeleteWords(text) {
  return !/delet|elimin|borrad/i.test(text)
}

function noStateClaim(text) {
  return !/still on|still off|nothing was changed|unchanged|sigue encendido|sigue apagado|no se cambió nada/i.test(text)
}

async function exercise(session, mode) {
  const copy = session.copy()
  if (mode === 'wrapper-control') {
    await session.evaluate(`fetch('/api/session-probe').then(r => r.status).catch(e => String(e))`, true)
    const snapshot = await session.waitFor(`(() => {
      const signIn = [...document.querySelectorAll('button')].some(el => el.textContent.trim() === ${JSON.stringify(copy['auth.signIn'])})
      return { ready: signIn, body: document.body?.innerText?.slice(0, 400) || '' }
    })()`, 8000)
    const view = await session.snapshot()
    for (let attempt = 0; attempt < 30 && session.logoutCalls().length < 1; attempt++) await sleep(50)
    const probe = session.api.filter(call => call.path === '/api/session-probe')
    const pass = signedOut(view, session.locale)
      && probe.length === 1
      && probe[0].status === 401
      && probe[0].viaSessionFetch === true
      && session.logoutCalls().length >= 1
      && session.deactivateCalls().length === 0
    return {
      pass,
      observed: pass
        ? 'GET /api/session-probe returned 401 through sessionFetch.js and the shell showed the sign-in button.'
        : `control did not sign out. snapshot=${JSON.stringify(view)} api=${JSON.stringify(session.api)}`,
      snapshot: view,
      extra: snapshot,
    }
  }

  await session.clickButton(copy['account.deactivate.submit'])
  const dialog = await session.waitFor(`(() => {
    const title = document.getElementById('confirm-title')?.textContent?.trim() || ''
    return { ready: title === ${JSON.stringify(copy['account.deactivate.confirmTitle'])}, title }
  })()`, 8000)

  if (mode === 'copy' || mode === 'cancel') {
    const view = await session.snapshot()
    const dialogText = `${view.dialogTitle}\n${view.dialogBody}`
    const pageText = `${view.h1}\n${view.h2}\n${view.help}`
    const copyPass = view.h1 === copy['account.title']
      && view.helpVisible
      && view.h2 === copy['account.deactivate.title']
      && view.dialogTitle === copy['account.deactivate.confirmTitle']
      && view.dialogBody === copy['account.deactivate.confirmBody']
      && view.buttons.includes(copy['account.deactivate.confirm'])
      && view.buttons.includes(copy['account.deactivate.cancel'])
      && noDeleteWords(`${dialogText}\n${pageText}\n${view.buttons.join('\n')}`)
      && session.deactivateCalls().length === 0
    if (mode === 'copy') {
      const englishTitle = STRINGS.en['account.deactivate.confirmTitle']
      const spanishDistinct = session.locale === 'en' || view.dialogTitle !== englishTitle
      return {
        pass: copyPass && spanishDistinct && Boolean(dialog.ready),
        observed: `dialog title ${JSON.stringify(view.dialogTitle)}; body ${JSON.stringify(view.dialogBody)}; deactivate posts ${session.deactivateCalls().length}.`,
        snapshot: view,
      }
    }
    await session.clickButton(copy['account.deactivate.cancel'])
    const after = await session.waitFor(`(() => ({
      ready: !document.querySelector('[role="alertdialog"]') && document.querySelector('h2')?.textContent?.trim() === ${JSON.stringify(copy['account.deactivate.title'])},
    }))()`, 8000)
    const settled = await session.snapshot()
    const pass = copyPass
      && after.ready
      && !settled.dialogOpen
      && stayedSignedIn(settled, session.locale)
      && session.deactivateCalls().length === 0
      && session.logoutCalls().length === 0
    return {
      pass,
      observed: pass
        ? 'Cancel closed the dialog. No POST /api/auth/deactivate and no logout. Sign out stayed on the page.'
        : `cancel mismatch. before=${JSON.stringify(view)} after=${JSON.stringify(settled)} api=${JSON.stringify(session.api)}`,
      snapshot: settled,
    }
  }

  await session.clickButton(copy['account.deactivate.confirm'])
  if (mode === 'success') {
    const settled = await session.waitFor(`(() => ({
      ready: [...document.querySelectorAll('button')].some(el => el.textContent.trim() === ${JSON.stringify(copy['auth.signIn'])}),
      body: document.body?.innerText?.slice(0, 400) || '',
    }))()`, 8000)
    const view = await session.snapshot()
    const posts = session.deactivateCalls()
    const pass = signedOut(view, session.locale)
      && posts.length === 1
      && posts[0].status === 200
      && posts[0].viaSessionFetch === true
      && session.logoutCalls().length >= 1
      && settled.ready
    return {
      pass,
      observed: pass
        ? 'POST /api/auth/deactivate returned 200 { deactivated: true } through sessionFetch.js. The shell showed Sign in and posted logout.'
        : `success mismatch. view=${JSON.stringify(view)} api=${JSON.stringify(session.api)}`,
      snapshot: view,
    }
  }

  const failed = copy['account.deactivate.failed']
  const lastAdmin = copy['account.deactivate.lastAdmin']
  const expect = mode === '409' ? lastAdmin : failed
  const settled = await session.waitFor(`(() => {
    const alert = document.querySelector('[role="alert"]')?.textContent?.trim() || ''
    return { ready: alert === ${JSON.stringify(expect)}, alert }
  })()`, 8000)
  const view = await session.snapshot()
  const posts = session.deactivateCalls()
  const hiddenServer = mode === '409'
    ? SERVER_LAST_ADMIN
    : mode === '500'
      ? SERVER_500
      : mode === '401'
        ? SERVER_401
        : ''
  const pass = settled.ready
    && view.alert === expect
    && stayedSignedIn(view, session.locale)
    && !view.dialogOpen
    && posts.length === 1
    && posts[0].viaSessionFetch === true
    && session.logoutCalls().length === 0
    && (mode === 'lost' ? posts[0].status === 'network-fail' : true)
    && (mode === '401' ? posts[0].status === 401 : true)
    && (mode === '500' ? posts[0].status === 500 : true)
    && (mode === '409' ? posts[0].status === 409 : true)
    && (mode === 'nonjson' ? posts[0].status === 200 : true)
    && (hiddenServer ? !view.alert.includes(hiddenServer) && !documentServerLeak(view, hiddenServer) : true)
    && (mode === '409' ? view.alert.includes(session.locale === 'es' ? 'sigue encendido' : 'stays on') : noStateClaim(view.alert))
    && noDeleteWords(view.alert)
  return {
    pass,
    observed: `alert ${JSON.stringify(view.alert)}; deactivate ${JSON.stringify(posts.map(post => ({ status: post.status, viaSessionFetch: post.viaSessionFetch, top: post.frames[0] })))}; logout ${session.logoutCalls().length}; signedIn ${stayedSignedIn(view, session.locale)}.`,
    snapshot: view,
  }
}

function documentServerLeak(view, sentence) {
  return `${view.h1}\n${view.alert}\n${view.dialogBody}`.includes(sentence)
}

// 401, 500, a lost response, and a non-JSON 200 are specified to show the
// same unknown-result sentence. Their PNGs can match. The status is in
// the transport log, not in a second picture.
const CASES = [
  { id: 'wrapper-control', locale: 'en', scenario: 'none', mode: 'wrapper-control', shot: '01-wrapper-control.png', report: false },
  { id: 'http-401', locale: 'en', scenario: '401', mode: '401', shot: '02-http-401.png', report: true },
  { id: 'http-500', locale: 'en', scenario: '500', mode: '500', shot: '03-http-500.png', report: true },
  { id: 'cancel', locale: 'en', scenario: 'none', mode: 'cancel', shot: '04-cancel.png', report: true },
  { id: 'success-logout', locale: 'en', scenario: 'success', mode: 'success', shot: '05-success-logout.png', report: true },
  { id: 'last-admin-409', locale: 'en', scenario: '409', mode: '409', shot: '06-last-admin-409.png', report: true },
  { id: 'lost-network', locale: 'en', scenario: 'lost', mode: 'lost', shot: '07-lost-network.png', report: true },
  { id: 'non-json-200', locale: 'en', scenario: 'nonjson', mode: 'nonjson', shot: '08-non-json-200.png', report: true },
  { id: 'english-copy', locale: 'en', scenario: 'none', mode: 'copy', shot: '09-english-copy.png', report: true },
  { id: 'spanish-copy', locale: 'es', scenario: 'none', mode: 'copy', shot: '10-spanish-copy.png', report: true },
  { id: 'spanish-last-admin', locale: 'es', scenario: '409', mode: '409', shot: '11-spanish-409.png', report: false },
  { id: 'spanish-lost-network', locale: 'es', scenario: 'lost', mode: 'lost', shot: '12-spanish-lost.png', report: false },
]

async function main() {
  await mkdir(outDir, { recursive: true })
  const productSha = sha()
  if (requiredSha && productSha !== requiredSha) {
    console.error(`HEAD moved. required ${requiredSha} actual ${productSha}`)
    process.exit(2)
  }
  const profile = await mkdtemp(join(tmpdir(), 'oc-headed-chrome-'))
  const viteLog = []
  const chromeLog = []
  const vite = spawn(process.execPath, [
    join(CLIENT, 'node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1',
    '--port', '5204',
    '--strictPort',
  ], {
    cwd: CLIENT,
    env: { ...process.env, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stdout.on('data', chunk => viteLog.push(String(chunk)))
  vite.stderr.on('data', chunk => viteLog.push(String(chunk)))
  const chrome = spawn('google-chrome', [
    '--remote-debugging-port=9333',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-popup-blocking',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1280,800',
    '--window-position=20,20',
    '--force-device-scale-factor=1',
    '--lang=en-US',
    'about:blank',
  ], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  chrome.stdout.on('data', chunk => chromeLog.push(String(chunk)))
  chrome.stderr.on('data', chunk => chromeLog.push(String(chunk)))

  const results = []
  try {
    await waitHttp(`${APP_ORIGIN}/`)
    await waitHttp('http://127.0.0.1:9333/json/version')
    const version = await fetch('http://127.0.0.1:9333/json/version').then(response => response.json())
    const browserWsUrl = version.webSocketDebuggerUrl
    for (const spec of CASES) {
      const started = capturedAt()
      let session
      try {
        session = await newPage(browserWsUrl, spec.locale, spec.scenario)
        await session.waitForAccount()
        const probe = await session.wrapperProbe()
        if (!wrapperOk(probe)) {
          const path = await session.screenshot(spec.shot)
          results.push({
            id: spec.id,
            report: spec.report,
            verdict: 'FAIL',
            url: ACCOUNT_URL,
            captured_at: started,
            screenshot: path,
            observed: `session wrapper was not the installed one: ${JSON.stringify(probe)}`,
            wrapper: probe,
          })
          continue
        }
        const outcome = await exercise(session, spec.mode)
        const path = await session.screenshot(spec.shot)
        const foreign = forbiddenHosts(session.hosts)
        const pass = outcome.pass && foreign.length === 0
        results.push({
          id: spec.id,
          report: spec.report,
          verdict: pass ? 'PASS' : 'FAIL',
          url: ACCOUNT_URL,
          environment: 'local-vite',
          device_class: 'desktop',
          viewport_css: '1280x800',
          device_scale: 1,
          captured_at: capturedAt(),
          screenshot: path,
          observed: foreign.length ? `${outcome.observed} Forbidden hosts: ${foreign.join(', ')}` : outcome.observed,
          wrapper: probe,
          navigator_onLine: outcome.snapshot?.onLine ?? 'NOT MEASURED',
          api: session.api.filter(call => call.path.includes('deactivate') || call.path.includes('logout') || call.path.includes('session-probe')),
          page_errors: session.errors.slice(0, 5),
        })
      } catch (error) {
        let path = ''
        if (session) {
          try { path = await session.screenshot(spec.shot.replace('.png', '-error.png')) } catch { /* no shot */ }
        }
        results.push({
          id: spec.id,
          report: spec.report,
          verdict: 'FAIL',
          url: ACCOUNT_URL,
          captured_at: started,
          screenshot: path,
          observed: error instanceof Error ? error.stack || error.message : String(error),
        })
      } finally {
        if (session) await session.close()
      }
    }
    const spanishCopy = results.find(row => row.id === 'spanish-copy')
    const spanish409 = results.find(row => row.id === 'spanish-last-admin')
    const spanishLost = results.find(row => row.id === 'spanish-lost-network')
    if (spanishCopy && spanishCopy.verdict === 'PASS') {
      const extras = [spanish409, spanishLost]
      if (extras.some(row => !row || row.verdict !== 'PASS')) {
        spanishCopy.verdict = 'FAIL'
        spanishCopy.observed += ` Spanish outcome copy failed: 409=${spanish409?.verdict || 'missing'} lost=${spanishLost?.verdict || 'missing'}.`
      } else {
        spanishCopy.observed += ' Spanish 409 showed the last-admin sentence. Spanish lost response showed the unknown-result sentence.'
      }
    }
    const report = {
      product_sha: productSha,
      command: 'node client-diocese/scripts/headed-self-deactivate.mjs',
      url: ACCOUNT_URL,
      environment: 'local-vite + synthetic CDP transport; headed google-chrome; no production; fictional Demonstration Diocese',
      browser: version.Browser,
      headless: false,
      cases: results,
    }
    await writeFile(join(outDir, 'results.json'), JSON.stringify(report, null, 2))
    await writeFile(join(outDir, 'vite.log'), viteLog.join('').slice(-20000))
    await writeFile(join(outDir, 'chrome.log'), chromeLog.join('').slice(-20000))
    console.log(JSON.stringify(report, null, 2))
    const reported = results.filter(row => row.report)
    if (reported.some(row => row.verdict !== 'PASS') || results.some(row => row.verdict !== 'PASS')) {
      process.exitCode = 1
    }
  } finally {
    try { chrome.kill('SIGTERM') } catch { /* already gone */ }
    try { vite.kill('SIGTERM') } catch { /* already gone */ }
    await sleep(300)
    try { chrome.kill('SIGKILL') } catch { /* already gone */ }
    try { vite.kill('SIGKILL') } catch { /* already gone */ }
    await rm(profile, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
