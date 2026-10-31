// R338-1: public support copy must not promise a read or response
// guarantee we cannot verify. Covers every supportPage.* string, EN + ES.
import { describe, it, expect } from 'vitest'
import { STRINGS } from './strings.js'

const FORBIDDEN = [
  /reads? every (message|email)/i,
  /every (message|email) (is|gets) read/i,
  /respond(s|ed)? within/i,
  /repl(y|ies) within/i,
  /will (always )?(respond|reply|answer)/i,
  /guarantee/i,
  /lee(mos)? cada (mensaje|correo)/i,
  /responde(mos|rá|remos)? (en|dentro de)/i,
  /contesta(mos|rá|remos)? (en|dentro de)/i,
  /garantiza/i,
]

for (const locale of ['en', 'es']) {
  describe(`support copy honesty (${locale})`, () => {
    const entries = Object.entries(STRINGS[locale]).filter(([k]) => k.startsWith('supportPage.'))

    it('has support copy to check', () => {
      expect(entries.length).toBeGreaterThan(0)
      expect(STRINGS[locale]['supportPage.body']).toBeTruthy()
    })

    it('makes no read or response guarantee', () => {
      const hits = entries.flatMap(([k, v]) =>
        FORBIDDEN.filter((re) => re.test(v)).map((re) => `${k}: ${re}`))
      expect(hits).toEqual([])
    })
  })
}
