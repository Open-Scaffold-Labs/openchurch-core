// Device verification of the surfaces changed in Pass 6.
//
// The API is down (the sandbox lost outbound 5432/6543 to the Supabase
// pooler mid-pass), so the CONTROL cannot be captured. What CAN be captured
// is the case that matters most on a phone: what these screens say when the
// read fails. A real outage is the honest-failure condition, arrived at
// honestly.
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js'
const { chromium } = pw
import { readFileSync, writeFileSync } from 'node:fs'
const TOKEN = readFileSync('/tmp/tok','utf8').trim()
const cfg = JSON.parse(process.argv[2])
const VIEWPORTS = {
  desktop: { width: 1440, height: 900,  touch: false },
  ipad:    { width: 1024, height: 1366, touch: true  },   // 13-inch, portrait
  iphone:  { width: 390,  height: 844,  touch: true  },
}
const b = await chromium.launch({ args:['--no-sandbox'] })
for (const [name, v] of Object.entries(VIEWPORTS)) {
  const ctx = await b.newContext({
    viewport: { width: v.width, height: v.height },
    hasTouch: v.touch, isMobile: v.touch, deviceScaleFactor: v.touch ? 2 : 1,
  })
  await ctx.addInitScript(t => localStorage.setItem('ochr_token', t), TOKEN)
  const page = await ctx.newPage()
  // The database is unreachable, so the app cannot even authenticate — every
  // route falls back to the sign-in screen and none of the changed surfaces
  // render at all. These stubs stand in for the API so the CHANGED SCREENS
  // can be seen at each size. This verifies layout, copy and reachability at
  // 390px; it does NOT verify anything against live data, and is reported as
  // such.
  await page.route('**/api/**', route => {
    const u = route.request().url()
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    // /api/auth/me answers { user: … }, not the user. Getting this wrong
    // dropped every run to the sign-in screen and looked like the pages
    // were broken.
    if (u.includes('/api/auth/me')) return json({ user: {
      id: 1, email: 'secretary@sttest.org', name: 'Secretary', role: 'admin',
      organization: { id: 1, name: 'St Test', slug: 'st-test', locale: 'en', tradition: 'general' },
    } })
    const stub = cfg.stub ?? {}
    for (const [frag, spec] of Object.entries(stub)) {
      if (u.includes(frag)) return json(spec.body ?? {}, spec.status ?? 200)
    }
    return json({ records: [], lines: [], total: 0, gift_count: 0, pledges: [], entries: [] })
  })
  await page.goto('http://127.0.0.1:5202'+cfg.path, { waitUntil:'domcontentloaded' })
  await page.waitForTimeout(cfg.wait ?? 5000)
  for (const label of cfg.click ?? []) {
    try { await page.getByRole('button', { name: new RegExp(label, 'i') }).first().click(); await page.waitForTimeout(900) }
    catch (e) { console.log(JSON.stringify({ view: name, CLICK_FAILED: label, err: e.message.split('\n')[0] })) }
  }
  const text = await page.locator('body').innerText()
  const out = `${cfg.name}-${name}`
  writeFileSync(`/home/claude/probe/${out}.txt`, text)
  await page.screenshot({ path:`/home/claude/probe/${out}.png`, fullPage: true })

  // Does anything overflow the viewport sideways? A failure message that
  // needs a horizontal scroll on a phone is not a message anyone reads.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  console.log(JSON.stringify({
    view: name, size: `${v.width}x${v.height}`,
    honest: ["couldn't", 'could not', 'try again', 'connection problem', 'came back incomplete']
      .filter(h => text.toLowerCase().includes(h.toLowerCase())),
    liesEmpty: ['No sacraments recorded yet'].filter(a => text.includes(a)),
    certificateFurniture: ['This is to certify that', 'Print / Save as PDF']
      .filter(a => text.includes(a)),
    horizontalOverflowPx: overflow,
  }))
  await ctx.close()
}
await b.close()
