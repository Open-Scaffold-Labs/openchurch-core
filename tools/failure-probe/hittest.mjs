import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js'
const { chromium } = pw
import { readFileSync } from 'node:fs'
const TOKEN = readFileSync('/tmp/tok','utf8').trim()
const b = await chromium.launch({ args:['--no-sandbox'] })
const ctx = await b.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true, deviceScaleFactor:2 })
await ctx.addInitScript(t => localStorage.setItem('ochr_token', t), TOKEN)
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:5202/tasks', { waitUntil:'domcontentloaded' })
await page.waitForTimeout(4500)
const results = await page.evaluate(() => {
  const out = []
  const sel = 'button[aria-label^="Delete task"], button[aria-label^="Mark"], .tap-reach'
  for (const el of [...document.querySelectorAll(sel)].slice(0, 6)) {
    const r = el.getBoundingClientRect(); if (!r.width) continue
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0,26)
    const cx = r.left + r.width/2, cy = r.top + r.height/2
    const reach = (dx,dy) => { let n=0; for (let d=1;d<=40;d++){ const t=document.elementFromPoint(cx+dx*d, cy+dy*d); if (t===el||el.contains(t)) n=d; else break } return n }
    const w = reach(1,0)+reach(-1,0)+Math.round(r.width)
    const h = reach(0,1)+reach(0,-1)+Math.round(r.height)
    out.push({label, visual:`${Math.round(r.width)}x${Math.round(r.height)}`, hittable:`${w}x${h}`, meets44: w>=44&&h>=44})
  }
  return out
})
console.log(JSON.stringify(results))
await b.close()
