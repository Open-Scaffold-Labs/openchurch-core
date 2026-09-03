// Touch-target measurement by DISPATCHED HIT TEST, not CSS inspection.
// getBoundingClientRect() cannot see a ::after pseudo-element, so it cannot
// measure `.tap-reach`. This probes outward from each control's centre and
// reports the area that actually belongs to it.
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js'
const { chromium } = pw
import { readFileSync } from 'node:fs'
const TOKEN = readFileSync('/tmp/tok','utf8').trim()
const VP = {
  desktop: { width: 1440, height: 900,  touch: false },
  ipad:    { width: 1032, height: 1376, touch: true },
  ipadLand:{ width: 1376, height: 1032, touch: true },
  iphone:  { width: 390,  height: 844,  touch: true },
}
const cfg = JSON.parse(process.argv[2])
const v = VP[cfg.device]
const b = await chromium.launch({ args:['--no-sandbox'] })
const ctx = await b.newContext({ viewport:{width:v.width,height:v.height}, hasTouch:v.touch, isMobile:v.touch, deviceScaleFactor:2 })
await ctx.addInitScript(t => localStorage.setItem('ochr_token', t), TOKEN)
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:5202'+cfg.path, { waitUntil:'domcontentloaded' })
await page.waitForTimeout(4500)

const out = await page.evaluate((rows) => {
  const res = []
  const sel = 'button[aria-label^="Mark"], button[aria-label^="Delete task"], button'
  const buttons = [...document.querySelectorAll(sel)]
    .filter(el => /^(Mark|Delete task|Edit)/.test((el.getAttribute('aria-label')||el.textContent||'').trim()))
  for (const el of buttons.slice(0, rows)) {
    const r = el.getBoundingClientRect(); if (!r.width) continue
    const label = (el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,22)
    const cx=r.left+r.width/2, cy=r.top+r.height/2
    const reach=(dx,dy)=>{let n=0;for(let d=1;d<=40;d++){const t=document.elementFromPoint(cx+dx*d,cy+dy*d);if(t===el||el.contains(t))n=d;else break}return n}
    const w=reach(1,0)+reach(-1,0)+Math.round(r.width)
    const h=reach(0,1)+reach(0,-1)+Math.round(r.height)
    // accessibility
    const cs = getComputedStyle(el)
    res.push({ label, visual:`${Math.round(r.width)}x${Math.round(r.height)}`,
               hit:`${w}x${h}`, ok: w>=44 && h>=44,
               name: !!(el.getAttribute('aria-label')||el.textContent.trim()),
               focusable: el.tabIndex >= 0 })
  }
  return res
}, cfg.rows ?? 9)
console.log(JSON.stringify({device:cfg.device, targets:out}))
await b.close()
