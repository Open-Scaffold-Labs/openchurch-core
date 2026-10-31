// Run libpq tools with the connection passed through PG* environment
// variables, never on the command line (no password in `ps` or in logs).
import { spawn } from 'node:child_process'
import { resolvePgTarget } from './lib.mjs'

// R370-1: takes a target already resolved by lib.resolvePgTarget (or a URL,
// which is resolved with the same default-deny rules and throws on any
// override). Every inherited PG* variable (PGHOST, PGPORT, PGSERVICE,
// PGSERVICEFILE, PGHOSTADDR, PGOPTIONS, PGPASSFILE, ...) is dropped first,
// so the validated host/port/database is the only one libpq can see.
export function pgEnv(target, base = process.env) {
  const t = typeof target === 'string' ? resolvePgTarget(target) : target
  if (!t || !t.ok) throw new Error(t?.reason || 'pgEnv: unresolved target')
  const env = {}
  for (const [k, v] of Object.entries(base)) if (!/^PG/.test(k)) env[k] = v
  Object.assign(env, { PGHOST: t.host, PGPORT: String(t.port), PGUSER: t.user, PGPASSWORD: t.password,
    PGDATABASE: t.database, PGAPPNAME: 'openchurch-backup-export', PGCONNECT_TIMEOUT: '20',
    PGSERVICEFILE: '/dev/null', PGPASSFILE: '/dev/null', PGSYSCONFDIR: '/nonexistent-oc-backup' })
  if (t.sslmode) env.PGSSLMODE = t.sslmode
  for (const k of ['DATABASE_URL', 'OC_BACKUP_DATABASE_URL', 'OC_RESTORE_DATABASE_URL', 'BLOB_READ_WRITE_TOKEN']) delete env[k]
  if (!env.PGUSER) delete env.PGUSER
  if (!env.PGPASSWORD) delete env.PGPASSWORD
  return env
}

// Resolves { stdout } on exit 0; rejects with the tool's stderr otherwise.
export function run(cmd, args, { env = process.env, input, stdoutFile } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve({ stdout: out, stderr: err })
      : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').slice(-5).join(' | ')}`)))
    if (input != null) child.stdin.end(input); else child.stdin.end()
  })
}

export async function psqlRows(env, sql) {
  const { stdout } = await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql], { env })
  return stdout.split('\n').filter(Boolean).map(l => l.split('\t'))
}

export const MIGRATION_HEAD_SQL = `SELECT count(*)::text,
  (SELECT name FROM ochr_schema_migrations ORDER BY substring(name from '^[0-9]+')::int DESC NULLS LAST, name DESC LIMIT 1)
  FROM ochr_schema_migrations`
export const TABLE_COUNT_SQL = `SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
export const EXTENSIONS_SQL = `SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql' ORDER BY 1`

export async function schemaFacts(env) {
  const [[count, head]] = await psqlRows(env, MIGRATION_HEAD_SQL)
  const [[tables]] = await psqlRows(env, TABLE_COUNT_SQL)
  const ext = (await psqlRows(env, EXTENSIONS_SQL)).map(([name, schema]) => ({ name, schema }))
  const [[serverVersion]] = await psqlRows(env, 'SHOW server_version')
  return { migration: { count: Number(count), head }, tableCount: Number(tables), extensions: ext, serverVersion }
}

// R370-3: open ONE session holding a REPEATABLE READ READ ONLY transaction,
// export its snapshot, and read the manifest facts inside that same
// transaction. The caller runs pg_dump --snapshot=<id> while the session
// stays open, so facts and archive describe the same database state even
// if a migration commits in between. close() commits and ends the session.
export async function openSnapshotSession(env) {
  const child = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''; let err = ''; let exited = null; const waiters = []
  const poke = () => { for (const w of waiters.splice(0)) w() }
  child.stdout.on('data', d => { out += d; poke() })
  child.stderr.on('data', d => { err += d })
  child.on('close', code => { exited = code; poke() })
  child.on('error', e => { err += e.message; exited = -1; poke() })
  let n = 0
  const query = async sql => {
    const mark = `__OC_END_${++n}__`
    child.stdin.write(`${sql};\n\\echo ${mark}\n`)
    for (;;) {
      const i = out.indexOf(mark + '\n')
      if (i > -1) { const body = out.slice(0, i); out = out.slice(i + mark.length + 1); return body.split('\n').filter(Boolean).map(l => l.split('\t')) }
      if (exited !== null) throw new Error(`psql snapshot session exited ${exited}: ${err.trim().split('\n').slice(-3).join(' | ')}`)
      await new Promise(r => waiters.push(r))
    }
  }
  try {
    await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const [[snapshot]] = await query('SELECT pg_export_snapshot()')
    const [[count, head]] = await query(MIGRATION_HEAD_SQL)
    const [[tables]] = await query(TABLE_COUNT_SQL)
    const extensions = (await query(EXTENSIONS_SQL)).map(([name, schema]) => ({ name, schema }))
    const [[serverVersion]] = await query('SHOW server_version')
    const facts = { migration: { count: Number(count), head }, tableCount: Number(tables), extensions, serverVersion }
    const close = async () => {
      if (exited === null) { await query('COMMIT'); child.stdin.end() }
      if (exited === null) await new Promise(r => child.on('close', r))
    }
    return { snapshot, facts, close }
  } catch (e) { child.kill(); throw e }
}

export async function toolMajor(cmd) {
  const { stdout } = await run(cmd, ['--version'])
  const m = /(\d+)\.(\d+)/.exec(stdout)
  if (!m) throw new Error(`could not read ${cmd} version`)
  return { major: Number(m[1]), text: stdout.trim() }
}
