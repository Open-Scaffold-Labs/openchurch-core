import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// The seeder deletes and rewrites a demo org. This check only reads the
// operator hint so a wrong path cannot ship without running that wipe.
test('the St. Brigid seeder hint names the intention book route', () => {
  const src = readFileSync(new URL('../server/src/demo/seedStBrigids.js', import.meta.url), 'utf8')
  const line = src.split('\n').find(l => l.includes('Try:'))
  assert.equal(
    line,
    '    console.log(`  Try: /register  ·  /mass-intentions  ·  /mass-intentions/print  ·  /register/<id>/certificate\\n`)',
  )
})
