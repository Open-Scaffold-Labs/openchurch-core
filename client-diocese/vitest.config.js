// Chancery test runner. Separate from vite.config.js so the app build
// stays untouched. Smallest environment that can render ConfirmProvider.

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    testTimeout: 10_000,
  },
})
