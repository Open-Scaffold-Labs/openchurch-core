// Failure-state observer (protocol §13).
// Boots the real client against the real server, injects a session, then
// forces chosen /api routes to fail and records what the screen SAYS.
// The question is never "did it crash" — it is "did it claim None".
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js'
const { chromium } = pw
import { readFileSync, writeFileSync } from 'node:fs'

const TOKEN = readFileSync('/tmp/tok', 'utf8').trim()
const BASE = 'http://127.0.0.1:5202'

const scenario = JSON.parse(process.argv[2])
const { name, path, fail = [], wait = 3500, clicks = [] } = scenario

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addInitScript(t => localStorage.setItem('ochr_token', t), TOKEN)
const page = await ctx.newPage()

const hits = []
await page.route('**/api/**', route => {
  const url = route.request().url()
  const match = fail.find(f => url.includes(f))
  if (match) {
    hits.push(match)
    return route.fulfill({ status: 500, contentType: 'application/json',
                           body: JSON.stringify({ error: 'forced failure' }) })
  }
  return route.continue()
})

const errors = []
page.on('pageerror', e => errors.push(String(e).split('\n')[0]))

await page.goto(BASE + path, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(wait)
for (const c of clicks) {
  try { await page.click(c, { timeout: 4000 }); await page.waitForTimeout(2000) }
  catch { errors.push(`click miss: ${c}`) }
}

const text = (await page.locator('body').innerText()).replace(/\n{2,}/g, '\n')
await page.screenshot({ path: `/home/claude/probe/${name}.png`, fullPage: false })

// The tells: phrases that assert emptiness as a fact.
// Strip the honest sentences BEFORE hunting for emptiness claims — the
// remedy text contains the phrase it exists to deny ("not a sign that your
// parish has no members"), and an instrument that flags its own fix is
// worse than no instrument.
const REMEDY = [
  /It is not a sign that your parish has no members\./g,
  /not a sign that they are gone\./g,
  /That's a connection problem, not a parish with no members\./g,
  /This is a connection problem, not an empty calendar\./g,
]
let scan = text
for (const r of REMEDY) scan = scan.replace(r, '')

const LIES = ['No tasks yet', 'Add your first task', 'No tasks found', 'No events yet',
              'No matching members', 'No members', 'no members', 'Not linked',
              "isn't on any events yet", 'No records', 'No notifications yet',
              'No mass intentions', 'No Mass intentions yet',
              // Added after an audit found the instrument blind to these.
              'No pending drafts', 'No service plans',
              'No events found', 'No members yet', 'Add your first member',
              'Add your first event', 'No matching members']
const HONEST = ["didn't load", 'did not load', "couldn't", 'could not', 'not complete',
                'may be incomplete', 'connection problem', 'Try again', 'no se cargó']

writeFileSync(`/home/claude/probe/${name}.txt`, text)
console.log(JSON.stringify({
  name,
  forcedRoutesHit: [...new Set(hits)],
  claimsEmptiness: LIES.filter(l => scan.includes(l)),
  admitsFailure: HONEST.filter(h => text.toLowerCase().includes(h.toLowerCase())),
  pageErrors: [...new Set(errors)],
}, null, 2))

await browser.close()
