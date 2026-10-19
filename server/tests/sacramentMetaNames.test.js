// Certificate meta write path. Godparents and sponsors that arrive as
// [{ name }] used to be stored with String(object), which is the literal
// "[object Object]". The register keeps a string name, or entry.name when
// that field is a string, and omits an entry that is not a name.
//
// This file does not open a database. parseMetaAttributes only queries
// when spouse_client_id is present, and these cases do not send one.
// POST, PATCH, and draft commit all persist JSON.stringify(meta.value).

import { describe, it, expect } from 'vitest'
import { parseMetaAttributes } from '../src/routes/sacraments.js'

const ORG = 1

describe('sacrament meta witness names', () => {
  it('stores a string name and entry.name, and never the stringification of an object', async () => {
    const meta = await parseMetaAttributes({
      godparents: [
        { name: ' Ana Ruiz ' },
        ' Jose Ruiz ',
        {},
        { name: '   ' },
        { name: { first: 'No' } },
        { role: 'godmother' },
        null,
      ],
      sponsors: [{ name: 'Lucia M.' }, {}],
    }, ORG)

    expect(meta.error).toBeUndefined()
    expect(meta.value.godparents).toEqual(['Ana Ruiz', 'Jose Ruiz'])
    expect(meta.value.sponsors).toEqual(['Lucia M.'])
    expect(JSON.stringify(meta.value)).not.toContain('[object Object]')
  })

  it('omits a list that names nobody, including a bare object', async () => {
    const meta = await parseMetaAttributes({
      godparents: [{}, { name: 1 }, []],
      sponsors: ['', '   '],
    }, ORG)

    expect(meta.error).toBeUndefined()
    expect(meta.value).toEqual({})
    expect(JSON.stringify(meta.value)).not.toContain('[object Object]')
  })

  it('still stores a plain list of names', async () => {
    const meta = await parseMetaAttributes({
      godparents: ['Ana Ruiz', 'Pedro Ruiz'],
    }, ORG)

    expect(meta.value.godparents).toEqual(['Ana Ruiz', 'Pedro Ruiz'])
  })

  it('still refuses a name longer than 200 characters', async () => {
    const meta = await parseMetaAttributes({
      sponsors: [{ name: 'L'.repeat(201) }],
    }, ORG)

    expect(meta.error).toBe('sponsors names must be 200 characters or fewer')
  })
})
