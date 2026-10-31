// R400-1: dropScratchDatabase must refuse any name it did not create in this
// process — above all the shared suite database — before it terminates or
// drops anything. The admin client here is a recorder, not a connection, so
// no real database is touched.
import { describe, it, expect } from 'vitest'
import { dropScratchDatabase, SCRATCH_MARKER } from './support/scratchDb.js'

function recorder() {
  const calls = { queries: [], ended: 0 }
  return { calls, admin: { query: async (sql) => { calls.queries.push(sql) }, end: async () => { calls.ended++ } } }
}

describe('dropScratchDatabase guard (R400-1)', () => {
  it('rejects the shared suite database name without issuing any query', async () => {
    const base = new URL(process.env.DATABASE_URL || 'postgres://x@localhost/openchurch_test').pathname.slice(1)
    expect(base).toMatch(/^[a-z0-9_]+$/)
    const { calls, admin } = recorder()
    await expect(dropScratchDatabase(admin, base)).rejects.toThrow(/refusing/)
    expect(calls.queries).toEqual([])
    expect(calls.ended).toBe(1)
  })

  it('rejects an untracked name that carries the scratch prefix', async () => {
    const { calls, admin } = recorder()
    const fake = `openchurch_test_${SCRATCH_MARKER}_${process.pid}_zzzzzz_rec_abc`
    await expect(dropScratchDatabase(admin, fake)).rejects.toThrow(/refusing/)
    expect(calls.queries).toEqual([])
  })

  it('rejects a valid unprefixed name', async () => {
    const { calls, admin } = recorder()
    await expect(dropScratchDatabase(admin, 'postgres')).rejects.toThrow(/refusing/)
    expect(calls.queries).toEqual([])
  })
})
