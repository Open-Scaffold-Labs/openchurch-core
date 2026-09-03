// Touch targets and focus on the public surfaces. (Pass 10 §12)
//
// WHAT THIS CANNOT SEE: it measures the element's own box, so a control whose
// hit area comes from a ::after pseudo-element reads as too small. Pass 5
// learned that the hard way; anything flagged here is a question, not a verdict.
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js'
const { chromium } = pw
import { readFileSync } from 'node:fs'
const cfg = JSON.parse(process.argv[2])
const b = await chromium.launch({ args:['--no-sandbox'] })
const ctx = await b.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true, deviceScaleFactor:2 })
try { await ctx.addInitScript(t => localStorage.setItem('ochr_token', t), readFileSync('/tmp/tok','utf8').trim()) } catch {}
const page = await ctx.newPage()
if (cfg.stub) await page.route('**/api/**', route => {
  const u = route.request().url()
  for (const [frag, spec] of Object.entries(cfg.stub))
    if (u.includes(frag)) return route.fulfill({ status: spec.status ?? 200, contentType:'application/json', body: JSON.stringify(spec.body ?? {}) })
  return route.continue()
})
await page.goto('http://127.0.0.1:5202'+cfg.path, { waitUntil:'domcontentloaded' })
await page.waitForTimeout(cfg.wait ?? 5000)
if (cfg.type) {
  try { await page.getByRole('textbox').first().fill(cfg.type); await page.waitForTimeout(1200) } catch {}
}

const report = await page.evaluate(() => {
  const small = [], noName = []
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 30)
    if (r.height < 44 || r.width < 44) small.push(`${label || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`)
    if (!label && !el.getAttribute('aria-labelledby') && !el.id) noName.push(el.tagName)
  }
  // Is the failure message announced, or only visible?
  const live = [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')]
    .map(e => (e.textContent || '').trim().slice(0, 60)).filter(Boolean)
  return { small: small.slice(0, 8), unnamed: noName.slice(0, 5), announced: live }
})
console.log(JSON.stringify({ path: cfg.path, ...report }, null, 1))
await b.close()
