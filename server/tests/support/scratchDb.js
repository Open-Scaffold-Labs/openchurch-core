// A database this file owns, beside the one the rest of the suite shares.
//
// db.js captures DATABASE_URL into its pool at import time, and the suite
// runs many files at once against one database. A test that has to see a
// stable set of rows — or that walks every organization — cannot use that
// shared database: other files create and delete parishes underneath it,
// and a walk of every parish gets slower as the suite's leftovers grow.
// The migration runner established the shape. Create the database, point
// DATABASE_URL at it, and only then import db.js. Drop it when the file
// is done, and put the original URL back so the next file on this worker
// does not inherit the scratch one (vitest reuses the worker and does not
// restore process.env).

import pg from 'pg'

const SAFE_NAME = /^[a-z0-9_]+$/
// Every scratch name carries this marker plus a per-process run id, and only
// names this process created may be dropped (R400-1): a syntactically valid
// name such as the shared suite database must never reach DROP DATABASE.
export const SCRATCH_MARKER = 'ocscratch'
const RUN_ID = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
const created = new Set()
// Captured at import, before any test points DATABASE_URL at a scratch db.
const ORIGINAL_BASE_NAME = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '') : null
let baseNameAtCreate = null

function baseNameOf(url) {
  return url ? new URL(url).pathname.replace(/^\//, '') : null
}

export function assertDroppableScratchName(name) {
  if (!SAFE_NAME.test(name)) throw new Error('refusing to drop a scratch database with an unsafe name')
  const bases = [baseNameAtCreate, ORIGINAL_BASE_NAME].filter(Boolean)
  if (bases.includes(name)) throw new Error('refusing to drop the base suite database')
  if (!name.includes(`_${SCRATCH_MARKER}_${RUN_ID}_`)) throw new Error('refusing to drop a database without this run\'s scratch prefix')
  if (!created.has(name)) throw new Error('refusing to drop a database this process did not create')
}

export async function createScratchDatabase(baseUrl, prefix) {
  if (!baseUrl) throw new Error('DATABASE_URL is not set')
  const baseName = baseNameOf(baseUrl)
  baseNameAtCreate ??= baseName
  const name = `${baseName}_${SCRATCH_MARKER}_${RUN_ID}_${prefix}_${Date.now().toString(36)}`
  if (!SAFE_NAME.test(name)) throw new Error('refusing to create a scratch database with an unsafe name')
  const admin = new pg.Client({ connectionString: baseUrl })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    created.add(name)
  } catch (err) {
    await admin.end().catch(() => {})
    throw err
  }
  const url = new URL(baseUrl)
  url.pathname = `/${name}`
  return { name, url: url.toString(), admin }
}

export async function dropScratchDatabase(admin, name) {
  if (!admin || !name) return
  try {
    assertDroppableScratchName(name)
  } catch (err) {
    await admin.end().catch(() => {})
    throw err
  }
  const terminate = () => admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name]).catch(() => {})
  try {
    await terminate()
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
  } catch {
    await terminate()
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
  } finally {
    created.delete(name)
    await admin.end().catch(() => {})
  }
}
