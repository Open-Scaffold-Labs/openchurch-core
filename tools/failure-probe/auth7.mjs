// Auth truth at runtime, against a genuinely dead API. (Pass 7 §2)
//
// The API server is down because the sandbox lost egress to the database —
// which is exactly the condition this correction is about. No stubbing: the
// browser really cannot reach /api/auth/me, and we watch what the app tells
// the person.
//
// WHAT THIS INSTRUMENT CANNOT SEE: it reads rendered text, so it cannot tell
// a session that survived from one that was cleared. That is why it also
// reads localStorage directly — the credential is the fact, the screen is
// the claim, and this pass is about the gap between them.
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
  if (cfg.meStatus) {
    await page.route('**/api/auth/me', route => route.fulfill({
      status: cfg.meStatus, contentType:'application/json',
      body: cfg.meBody ?? JSON.stringify({ error: 'forced' }),
    }))
  }
  await page.goto('http://127.0.0.1:5202'+(cfg.path ?? '/'), { waitUntil:'domcontentloaded' })
  await page.waitForTimeout(cfg.wait ?? 5000)

  if (cfg.clickRetry) {
    try { await page.getByRole('button', { name:/try again|inténtelo/i }).first().click()
          await page.waitForTimeout(2500) } catch(e){ console.log(JSON.stringify({RETRY_FAILED:e.message.split('\n')[0]})) }
  }

  const text = await page.locator('body').innerText()
  const out = `${cfg.name}-${name}`
  writeFileSync(`/home/claude/probe/${out}.txt`, text)
  await page.screenshot({ path:`/home/claude/probe/${out}.png`, fullPage:true })

  // The fact, read straight off the browser — not inferred from the screen.
  const tokenAfter = await page.evaluate(() => localStorage.getItem('ochr_token'))
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)

  console.log(JSON.stringify({
    view: name, url: page.url().replace('http://127.0.0.1:5202',''),
    tokenKept: tokenAfter === TOKEN,
    // FALSE ABSENCE: does the app claim she is signed out?
    showsSignIn: /welcome back|sign in to your church|iniciar sesión/i.test(text),
    // FALSE ASSERTION: does it claim anything it cannot know?
    saysUnconfirmed: /couldn'?t confirm your session|no pudimos confirmar/i.test(text),
    hasRetry: /try again|inténtelo de nuevo/i.test(text),
    horizontalOverflowPx: overflow,
  }))
  await ctx.close()
}
await b.close()
