import { assertIosBuildEnv } from './capServerUrl.js'

// Vite's production build loads .env, .env.local, .env.production, and
// .env.production.local after this process starts. A name that is already
// set is not replaced. Deleting VITE_ENABLE_IOS_PUSH lets a file turn the
// permission flow on. An empty string stays set, so the file cannot
// restore a refused API origin or a push flag the shell did not ask for.
export function sealIosChildEnv(shellEnv = process.env) {
  const checked = assertIosBuildEnv(shellEnv)
  const env = { ...shellEnv, VITE_CAPACITOR: '1' }
  env.VITE_API_URL = ''
  env.VITE_ENABLE_IOS_PUSH = checked.push ? '1' : ''
  return { checked, env }
}
