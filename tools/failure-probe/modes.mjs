// Honest-failure SECOND PASS (protocol §5).
// The first pass only ever forced a 500. These are the other ways a request
// fails, and each can produce a different lie.
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js'
const { chromium } = pw
import { readFileSync } from 'node:fs'
const TOKEN = readFileSync('/tmp/tok','utf8').trim()
const cfg = JSON.parse(process.argv[2])

const b = await chromium.launch({ args:['--no-sandbox'] })
const ctx = await b.newContext({ viewport:{width:1440,height:1000} })
await ctx.addInitScript(t => localStorage.setItem('ochr_token', t), TOKEN)
const page = await ctx.newPage()

await page.route('**/api/**', async route => {
  const url = route.request().url()
  if (!cfg.target.some(t => url.includes(t))) return route.continue()
  switch (cfg.mode) {
    case 'malformed':                       // 200 with HTML where JSON was promised
      return route.fulfill({ status:200, contentType:'text/html', body:'<!doctype html><h1>Gateway</h1>' })
    case 'truncated':                       // 200 with JSON that stops mid-object
      return route.fulfill({ status:200, contentType:'application/json', body:'{"rows":[{"id":1,' })
    case 'forbidden':
      return route.fulfill({ status:403, contentType:'application/json', body:'{"error":"Forbidden"}' })
    case 'timeout':
      await new Promise(r => setTimeout(r, 30000)); return route.abort('timedout')
    case 'emptyok':                         // a genuine, successful, empty answer
      return route.fulfill({ status:200, contentType:'application/json', body:'[]' })
    case 'nullok':
      return route.fulfill({ status:200, contentType:'application/json', body:'null' })
    default: return route.continue()
  }
})
const errs = []
page.on('pageerror', e => errs.push(String(e).split('\n')[0]))

await page.goto('http://127.0.0.1:5202'+cfg.path, { waitUntil:'domcontentloaded' })
await page.waitForTimeout(cfg.wait ?? 5000)
const text = await page.locator('body').innerText()
await page.screenshot({ path:`/home/claude/probe/${cfg.name}.png` })

const LIES=['No tasks yet','Add your first task','No members yet','Add your first member',
            'No events yet','Add your first event','No groups yet','No pending drafts',
            'No tasks found','No events found','undefined','NaN','$0.00']
const HONEST=["didn't load","did not load","couldn't","could not","try again",
              "connection problem","may be incomplete","permission","not allowed"]
console.log(JSON.stringify({
  name:cfg.name, mode:cfg.mode,
  claims: LIES.filter(l=>text.includes(l)),
  honest: HONEST.filter(h=>text.toLowerCase().includes(h.toLowerCase())),
  pageErrors:[...new Set(errs)],
}))
await b.close()
