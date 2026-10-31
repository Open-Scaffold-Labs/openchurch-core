// Local synthetic API for the iOS shell rehearsal.
//
// Refuses a remote, ambiguous, or provider-enabled target before the app
// or pg is imported, then starts server/src/index.js on the pinned local
// database. Does not sign, deploy, or read a production setting into the child.
//
//   node scripts/ios-local-api.mjs
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { planIosLocalApi } from './ios-local-api-guard.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const indexScript = fileURLToPath(new URL('../server/src/index.js', import.meta.url))

function refuse(reason) {
  console.error('refusing to start: ' + reason)
  process.exit(2)
}

if (process.argv.length > 2) refuse('usage: node scripts/ios-local-api.mjs')

const plan = planIosLocalApi(process.env)
if (plan.refuse) refuse(plan.refuse)

const child = spawn(process.execPath, [indexScript], {
  cwd: repoRoot,
  env: plan.childEnv,
  stdio: 'inherit',
})
child.on('error', (err) => refuse(err && err.code ? err.code : 'unable to start'))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code == null ? 1 : code)
})
