// Sacramental ACTION truth. §3 of Pass 6.
//
// A read that lies tells you something untrue. A write that lies makes you
// believe work was saved that was not — and on a register, that is a
// sacrament nobody can find later. This probe drives real UI actions with
// the write forced to fail and records what the page does afterwards:
// does the form stay open, do the values survive, does the row disappear,
// does anything claim success?
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js'
const { chromium } = pw
import { readFileSync, writeFileSync } from 'node:fs'
const TOKEN = readFileSync('/tmp/tok','utf8').trim()
const cfg = JSON.parse(process.argv[2])
const b = await chromium.launch({ args:['--no-sandbox'] })
const ctx = await b.newContext({ viewport:{width:1440,height:1200} })
await ctx.addInitScript(t => localStorage.setItem('ochr_token', t), TOKEN)
const page = await ctx.newPage()

const seen = []
let skipped = 0
await page.route('**/api/**', route => {
  const req = route.request()
  const u = req.url(), m = req.method()
  let hit = cfg.target && cfg.target.some(t => u.includes(t)) &&
            (!cfg.method || cfg.method === m)
  // skipFirst lets a probe leave the INITIAL load alone and break only the
  // reload that follows a successful write — the case where the page has
  // real data on screen and then has to decide what to do when it can no
  // longer confirm it.
  if (hit && cfg.skipFirst) { if (skipped < cfg.skipFirst) { skipped++; hit = false } }
  if (hit) seen.push(`${m} ${u.replace(/^https?:\/\/[^/]+/,'')} [FORCED ${cfg.mode}]`)
  else     seen.push(`${m} ${u.replace(/^https?:\/\/[^/]+/,'')}`)
  if (!hit) return route.continue()
  switch (cfg.mode) {
    case 'fail':      return route.fulfill({ status:500, contentType:'application/json', body:'{"error":"forced write failure"}' })
    case 'forbidden': return route.fulfill({ status:403, contentType:'application/json', body:'{"error":"Forbidden"}' })
    case 'empty':     return route.fulfill({ status:200, contentType:'application/json', body: cfg.body ?? '{}' })
    case 'abort':     return route.abort('failed')
    default: return route.continue()
  }
})
const errs=[]; page.on('pageerror', e=>errs.push(String(e).split('\n')[0]))

await page.goto('http://127.0.0.1:5202'+cfg.path, { waitUntil:'domcontentloaded' })
await page.waitForTimeout(3500)

// Correction 6: an <input>'s VALUE is not in innerText, so "did the form
// keep what I typed?" cannot be answered from the page text. It has to be
// read off the DOM.
const fieldValues = () => page.evaluate(() =>
  [...document.querySelectorAll('form input, form select, form textarea')]
    .map(el => el.value).filter(v => v !== ''))

const snap = async (tag) => {
  const text = await page.locator('body').innerText()
  writeFileSync(`/home/claude/probe/${cfg.name}-${tag}.txt`, text)
  await page.screenshot({ path:`/home/claude/probe/${cfg.name}-${tag}.png`, fullPage:true })
  return text
}
const before = await snap('before')
const valuesBefore = await fieldValues()

// Steps are declarative so the same instrument drives create, edit and remove.
for (const step of cfg.steps ?? []) {
  try {
    if (step.click)  await page.getByRole('button', { name: step.click }).first().click()
    if (step.link)   await page.getByRole('link',   { name: step.link  }).first().click()
    if (step.fill)   for (const [label, val] of Object.entries(step.fill)) {
      await page.getByLabel(label).first().fill(val)
    }
    // The sacrament form's <label>s are siblings with no htmlFor and the
    // inputs carry no id, so getByLabel cannot reach them (a finding in its
    // own right). Placeholder and CSS are the fallbacks.
    if (step.fillPlaceholder) for (const [ph, val] of Object.entries(step.fillPlaceholder)) {
      await page.getByPlaceholder(ph).first().fill(val)
    }
    if (step.fillCss) for (const [sel, val] of Object.entries(step.fillCss)) {
      await page.locator(sel).first().fill(val)
    }
    if (step.selectCss) for (const [sel, val] of Object.entries(step.selectCss)) {
      await page.locator(sel).first().selectOption(val)
    }
    if (step.select) for (const [label, val] of Object.entries(step.select)) {
      await page.getByLabel(label).first().selectOption(val)
    }
    if (step.submit) await page.getByRole('button', { name: step.submit }).first().click()
    await page.waitForTimeout(step.wait ?? 2500)
  } catch (e) {
    writeFileSync(`/home/claude/probe/${cfg.name}-STEPERROR.txt`, `${JSON.stringify(step)}\n${e.message}`)
    console.log(JSON.stringify({ name: cfg.name, STEP_FAILED: step, err: e.message.split('\n')[0] }))
    break
  }
}
const after = await snap('after')
const valuesAfter = await fieldValues()

// What the UI claims after a forced-failed write.
const SUCCESS = ['Saved','saved','Added','added','Record added','Updated','updated','Removed','removed','Success','Done']
const FORMOPEN = ['New record','Edit record']
console.log(JSON.stringify({
  name: cfg.name, mode: cfg.mode || 'control', method: cfg.method || 'any',
  writeAttempted: seen.some(s => s.includes('FORCED')),
  requests: seen.filter(s => !s.startsWith('GET ')),
  // Correction 5: innerText returns CSS-transformed text, so "New record"
  // arrives as "NEW RECORD". Case-sensitive matching reported the form as
  // closed when it was plainly on screen. Same mistake as the honest-failure
  // linter made in Pass 3; matching is case-insensitive from here on.
  formStillOpen: FORMOPEN.some(f => after.toLowerCase().includes(f.toLowerCase())),
  claimsSuccess: SUCCESS.filter(s => after.toLowerCase().includes(s.toLowerCase())
                                  && !before.toLowerCase().includes(s.toLowerCase())),
  valuesAfter,
  fieldsLost: (cfg.retain ?? []).filter(v => !valuesAfter.includes(v)),
  errorShown: /Failed \(\d+\)|forced write failure|Failed to fetch|couldn't|could not/.test(after),
  // Did anything the user could see disappear?
  vanished: (cfg.watch ?? []).filter(w => before.includes(w) && !after.includes(w)),
  stillPresent: (cfg.watch ?? []).filter(w => after.includes(w)),
  fieldsRetained: (cfg.retain ?? []).filter(v => valuesAfter.includes(v)),
  pageErrors: [...new Set(errs)],
}))
await b.close()
