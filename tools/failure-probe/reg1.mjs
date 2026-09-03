// REG.1 at runtime, against a real database. (Pass 8 §7–§13, §19)
//
// WHAT THIS INSTRUMENT CANNOT SEE: it reads rendered text and clicks, so it
// cannot tell a record that was voided from one that was deleted. It asks
// the API afterwards for the row's actual state — the database is the fact,
// the screen is the claim.
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js'
const { chromium } = pw
import { readFileSync, writeFileSync } from 'node:fs'
const TOKEN = readFileSync('/tmp/tok','utf8').trim()
const cfg = JSON.parse(process.argv[2])
const VIEWPORTS = { desktop:[1440,900,false], ipad:[1024,1366,true], iphone:[390,844,true] }
const b = await chromium.launch({ args:['--no-sandbox'] })

for (const [name,[w,h,touch]] of Object.entries(VIEWPORTS)) {
  if (cfg.only && cfg.only !== name) continue
  const ctx = await b.newContext({ viewport:{width:w,height:h}, hasTouch:touch, isMobile:touch,
                                   deviceScaleFactor: touch ? 2 : 1 })
  await ctx.addInitScript(t => localStorage.setItem('ochr_token', t), TOKEN)
  const page = await ctx.newPage()
  const errs = []; page.on('pageerror', e => errs.push(String(e).split('\n')[0]))
  await page.goto('http://127.0.0.1:5202'+cfg.path, { waitUntil:'domcontentloaded' })
  await page.waitForTimeout(cfg.wait ?? 4500)

  for (const step of cfg.steps ?? []) {
    try {
      if (step.click)   await page.getByRole('button', { name: new RegExp(step.click,'i') }).first().click()
      if (step.link)    await page.getByRole('link',   { name: new RegExp(step.link,'i')   }).first().click()
      if (step.type != null) {
        const d = page.getByRole('alertdialog')
        await d.getByRole('textbox').first().fill(step.type)
      }
      if (step.confirm) await page.getByRole('alertdialog').getByRole('button', { name: new RegExp(step.confirm,'i') }).click()
      await page.waitForTimeout(step.wait ?? 1800)
    } catch (e) {
      console.log(JSON.stringify({ view: name, STEP_FAILED: step, err: e.message.split('\n')[0] }))
      break
    }
  }

  const text = await page.locator('body').innerText()
  const out = `${cfg.name}-${name}`
  writeFileSync(`/home/claude/probe/${out}.txt`, text)
  await page.screenshot({ path:`/home/claude/probe/${out}.png`, fullPage:true })

  // Touch targets on the actions row, measured rather than assumed.
  const small = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('button, a[href]')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue
      const label = (el.textContent || '').trim().slice(0, 28)
      if ((r.height < 44 || r.width < 44) && label) out.push(`${label} ${Math.round(r.width)}x${Math.round(r.height)}`)
    }
    return out.slice(0, 6)
  })
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)

  console.log(JSON.stringify({
    view: name,
    saysVoid: /this entry is void/i.test(text),
    saysPreserved: /remains in the register|permanece en el registro/i.test(text),
    // FALSE ASSERTION: does a voided entry still offer to certify?
    offersCertificate: /\bCertificate\b/.test(text) && !/could not|no certificate/i.test(text),
    saysDelete: /\bdelete\b|\bremove\b/i.test(text),
    historyEntries: (text.match(/Correction|Voided|Restored/g) || []).length,
    smallTargets: small,
    horizontalOverflowPx: overflow,
    pageErrors: [...new Set(errs)],
  }))
  await ctx.close()
}
await b.close()
