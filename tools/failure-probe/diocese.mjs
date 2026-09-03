// client-diocese honest-failure sample. Same discipline as the parish probe:
// force a SUCCESSFUL EMPTY and a FAILED request separately, and compare both
// against an unforced control — because a chancery legitimately can have no
// approved submissions, and "$0.00" is then the truth.
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js'
const { chromium } = pw
import { readFileSync, writeFileSync } from 'node:fs'
const TOKEN = readFileSync('/tmp/diotok','utf8').trim()
const cfg = JSON.parse(process.argv[2])
const b = await chromium.launch({ args:['--no-sandbox'] })
const ctx = await b.newContext({ viewport:{width:1440,height:1000} })
await ctx.addInitScript(t => { localStorage.setItem('ochr_token', t); localStorage.setItem('od_token', t) }, TOKEN)
const page = await ctx.newPage()
await page.route('**/api/**', route => {
  const u = route.request().url()
  if (!cfg.target || !cfg.target.some(t => u.includes(t))) return route.continue()
  if (cfg.mode === 'fail')   return route.fulfill({ status:500, contentType:'application/json', body:'{"error":"forced"}' })
  if (cfg.mode === 'empty')  return route.fulfill({ status:200, contentType:'application/json', body: cfg.body ?? '{"parishes":[],"totals":{},"submission_count":0}' })
  return route.continue()
})
const errs=[]; page.on('pageerror', e=>errs.push(String(e).split('\n')[0]))
await page.goto('http://127.0.0.1:5204'+cfg.path, { waitUntil:'domcontentloaded' })
await page.waitForTimeout(cfg.wait ?? 5000)
const text = await page.locator('body').innerText()
writeFileSync(`/home/claude/probe/${cfg.name}.txt`, text)
await page.screenshot({ path:`/home/claude/probe/${cfg.name}.png` })
const LIES=['No parishes','no parishes','No activity','No submissions','No approved submissions',
            '$0.00','0.00','No data','undefined','NaN','No results','None']
const HONEST=["didn't load","did not load","couldn't","could not","try again","connection problem",
              "may be incomplete","unavailable","not load"]
console.log(JSON.stringify({name:cfg.name, mode:cfg.mode||'control',
  claims: LIES.filter(l=>text.includes(l)),
  honest: HONEST.filter(h=>text.toLowerCase().includes(h.toLowerCase())),
  pageErrors:[...new Set(errs)]}))
await b.close()
