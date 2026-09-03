// Sacramental honest-failure probe. CONTROL FIRST, always.
//
// The dangerous outcomes here are not cosmetic: a register that says "no
// record" because a request failed is a parish being told a baptism was
// never entered, and a certificate rendered from an empty response is a
// document asserting something nobody verified.
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js'
const { chromium } = pw
import { readFileSync, writeFileSync } from 'node:fs'
const TOKEN = readFileSync('/tmp/tok','utf8').trim()
const cfg = JSON.parse(process.argv[2])
const b = await chromium.launch({ args:['--no-sandbox'] })
const ctx = await b.newContext({ viewport:{width:cfg.w??1440,height:cfg.h??1000}, hasTouch:!!cfg.touch, isMobile:!!cfg.touch })
await ctx.addInitScript(t => localStorage.setItem('ochr_token', t), TOKEN)
const page = await ctx.newPage()
await page.route('**/api/**', route => {
  const u = route.request().url()
  if (!cfg.target || !cfg.target.some(t => u.includes(t))) return route.continue()
  switch (cfg.mode) {
    case 'fail':      return route.fulfill({ status:500, contentType:'application/json', body:'{"error":"forced"}' })
    case 'notfound':  return route.fulfill({ status:404, contentType:'application/json', body:'{"error":"Not found"}' })
    case 'forbidden': return route.fulfill({ status:403, contentType:'application/json', body:'{"error":"Forbidden"}' })
    case 'empty':     return route.fulfill({ status:200, contentType:'application/json', body: cfg.body ?? '{"records":[]}' })
    case 'malformed': return route.fulfill({ status:200, contentType:'text/html', body:'<!doctype html><h1>gw</h1>' })
    case 'abort':     return route.abort('failed')
    default: return route.continue()
  }
})
const errs=[]; page.on('pageerror', e=>errs.push(String(e).split('\n')[0]))
await page.goto('http://127.0.0.1:5202'+cfg.path, { waitUntil:'domcontentloaded' })
await page.waitForTimeout(cfg.wait ?? 5000)
const text = await page.locator('body').innerText()
writeFileSync(`/home/claude/probe/${cfg.name}.txt`, text)
await page.screenshot({ path:`/home/claude/probe/${cfg.name}.png` })
// Phrases that assert something about the REGISTER as fact.
const ASSERTS=['No records','no records','No sacramental records','No entries','No amendments',
               'no amendments','No history','No record','nothing recorded',
               'No corrections','never amended',
               // Added 27 Aug: the instrument missed the register's own phrase.
               'No sacraments recorded yet','No matching records','No drafts','No pending drafts',
               // Added 27 Aug (correction 4): the instrument watched only for
               // emptiness claims, so it could not see the certificate defect
               // at all — a document that ASSERTS a sacrament happened is the
               // strongest claim on this surface, and it was unmonitored.
               'This is to certify that','according to the rites of the Church',
               'Por la presente se certifica que','Print / Save as PDF']
const HONEST=["didn't load","did not load","couldn't","could not","try again",
              "connection problem","may be incomplete","unavailable","not load","problem"]
console.log(JSON.stringify({name:cfg.name, mode:cfg.mode||'control',
  asserts: ASSERTS.filter(a=>text.includes(a)),
  honest: HONEST.filter(h=>text.toLowerCase().includes(h.toLowerCase())),
  // does the control's real data still appear?
  hasControlData: text.includes('P6-001') || text.includes('Fr. Corrected'),
  pageErrors:[...new Set(errs)]}))
await b.close()
