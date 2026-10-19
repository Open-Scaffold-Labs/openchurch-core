// Isolated production-bundle probe for Auth-01.
// Must run as a child process (not under Vitest) so import.meta.env.DEV
// is the production false, not the test runner's true.
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(CLIENT_ROOT, 'src/pages/Login.jsx')

const result = await build({
  configFile: false,
  root: CLIENT_ROOT,
  mode: 'production',
  logLevel: 'silent',
  plugins: [react()],
  build: {
    write: false,
    emptyOutDir: false,
    lib: {
      entry,
      name: 'LoginProbe',
      formats: ['es'],
      fileName: () => 'login-probe.js',
    },
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react-router-dom',
        'framer-motion',
        'lucide-react',
      ],
    },
  },
})

const chunks = Array.isArray(result) ? result : [result]
const out = chunks.flatMap(r => r.output).map(o => (
  o.type === 'chunk' ? o.code : (typeof o.source === 'string' ? o.source : '')
)).join('\n')

const FORBIDDEN = [
  'demo1234',
  'Use demo account',
  'SEED_APP_REVIEW',
  'APP_REVIEW_EMAIL',
  'APP_REVIEW_PASSWORD',
  'review@openchurch',
]
if (FORBIDDEN.some(s => out.includes(s))) {
  console.error('PASSWORD_PRESENT')
  process.exit(1)
}
console.log('PASSWORD_ABSENT')
